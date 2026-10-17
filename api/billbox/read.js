'use strict';
const { redis, json, readBody, kstNow } = require('./_lib');

/**
 * POST /api/billbox/read — 고지서 사진을 AI(Claude)로 읽기
 *
 * 받는 것: { deviceKey, image(base64, data: 접두사 없이), mediaType }
 * 하는 일: 사진을 메모리에서만 들고 Anthropic API에 보내 "무엇을·얼마·언제까지·계좌"를 JSON으로 받는다.
 * 지키는 것:
 *   - 사진·결과를 어디에도 저장하지 않는다(디스크 X, 로그 X, Redis에는 "몇 번 읽었는지" 숫자만).
 *   - Anthropic API는 보낸 데이터를 학습에 쓰지 않는다(상업 약관). 안내문에도 적어 둘 것.
 * 비용 방어(로그인 없는 공개 툴):
 *   - 기기키당 하루 BILLBOX_AI_DAILY(기본 20)장, 전체 월 BILLBOX_AI_MONTHLY(기본 5000)장.
 *   - 넘으면 429 → 폰이 알아서 폰 안 읽기(Tesseract)로 바꾼다.
 * 환경변수: ANTHROPIC_API_KEY(필수), BILLBOX_AI_MODEL(기본 claude-haiku-5-5), BILLBOX_AI_DAILY, BILLBOX_AI_MONTHLY
 */

const KINDS = ['electric', 'gas', 'water', 'health', 'pension', 'cartax', 'proptax', 'maint', 'telecom', 'rent', 'insurance', 'academy', 'loan', 'subscribe', 'fine', 'transfer', 'etc'];

const PROMPT = `한국의 고지서/청구서/납부 안내 사진이다. 아래 JSON 하나만 출력해라. 설명·코드펜스 금지.
{"doc":true,"issuer":"발행기관(짧게)","kind":"electric|gas|water|health|pension|cartax|proptax|maint|telecom|rent|insurance|academy|loan|subscribe|fine|etc","name":"짧은 항목 이름(예: 전기요금, 수도요금, 건강보험)","amount":납기내_청구금액_숫자,"amountLate":납기후_금액_숫자_또는_null,"due":"납부기한 YYYY-MM-DD","account":"은행이름 계좌번호(가상계좌 포함, 없으면 null)","tag":"독촉|압류예고|(해당 없으면 빈 문자열)","usage":{"value":숫자,"unit":"kWh|m3"} 또는 null}
규칙:
- amount는 "납기내" 금액이다. 납기후·연체 금액과 절대 바꾸지 마라. 쉼표 없이 정수.
- due는 "납기내" 기한이다. 납기후 기한이 아니다. 연도가 안 보이면 사진 속 다른 날짜(고지년월 등)로 추정해라.
- 독촉장·체납·압류예고면 tag에 적어라.
- 고지서가 아니면 {"doc":false}만 출력해라.
- 확실하지 않은 값은 null로 둬라. 지어내지 마라.`;

async function countUp(key, ttlSec) {
  const n = await redis('INCR', key);
  if (Number(n) === 1) await redis('EXPIRE', key, String(ttlSec));
  return Number(n);
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return json(res, 405, { error: 'method' });
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return json(res, 503, { error: 'no_key' }); // 키가 아직 없음 → 폰 읽기로

  const b = readBody(req);
  const dev = String(b.deviceKey || '');
  if (!/^[0-9a-f]{32}$/.test(dev)) return json(res, 400, { error: 'deviceKey' });
  const image = String(b.image || '');
  const mediaType = ['image/jpeg', 'image/png', 'image/webp'].includes(b.mediaType) ? b.mediaType : 'image/jpeg';
  // base64 2.8MB ≈ 사진 2MB. 폰이 1568px로 줄여 보내므로 보통 300~600KB
  if (!image || image.length > 2800000 || !/^[A-Za-z0-9+/=]+$/.test(image.slice(0, 1000))) return json(res, 400, { error: 'image' });

  // ---- 한도 (숫자만 저장, 사진·내용은 저장 안 함) ----
  const now = kstNow();
  const daily = Number(process.env.BILLBOX_AI_DAILY) || 20;
  const monthly = Number(process.env.BILLBOX_AI_MONTHLY) || 5000;
  try {
    const dCount = await countUp(`bb:ai:d:${dev}:${now.date}`, 2 * 86400);
    if (dCount > daily) return json(res, 429, { error: 'limit_daily' });
    const mCount = await countUp(`bb:ai:m:${now.date.slice(0, 7)}`, 40 * 86400);
    if (mCount > monthly) return json(res, 429, { error: 'limit_monthly' });
  } catch (_) {
    // Redis가 잠깐 안 되면 읽기 자체는 계속(한도는 best-effort)
  }

  // ---- Anthropic 호출 ----
  const model = process.env.BILLBOX_AI_MODEL || 'claude-haiku-5-5';
  let out = null;
  try {
    const ac = new AbortController();
    const to = setTimeout(() => ac.abort(), 40000);
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: ac.signal,
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        max_tokens: 400,
        temperature: 0,
        messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: mediaType, data: image } }, { type: 'text', text: PROMPT }] }],
      }),
    });
    clearTimeout(to);
    const j = await r.json();
    if (!r.ok) {
      const kind = r.status === 429 || r.status === 529 ? 'busy' : 'ai';
      return json(res, 502, { error: kind });
    }
    out = (j.content || []).map((c) => c.text || '').join('');
  } catch (_) {
    return json(res, 502, { error: 'ai' });
  }

  // ---- 결과 손질(모델이 덧말을 붙여도 JSON만 건짐) ----
  let data = null;
  try {
    const m = out.match(/\{[\s\S]*\}/);
    data = m ? JSON.parse(m[0]) : null;
  } catch (_) {}
  if (!data || data.doc === false) return json(res, 200, { ok: true, data: { doc: false } });

  const clean = {
    doc: true,
    issuer: typeof data.issuer === 'string' ? data.issuer.slice(0, 40) : '',
    kind: KINDS.includes(data.kind) ? data.kind : 'etc',
    name: typeof data.name === 'string' ? data.name.slice(0, 30) : '',
    amount: Number.isFinite(Number(data.amount)) && Number(data.amount) > 0 && Number(data.amount) < 1e9 ? Math.round(Number(data.amount)) : null,
    amountLate: Number.isFinite(Number(data.amountLate)) && Number(data.amountLate) > 0 ? Math.round(Number(data.amountLate)) : null,
    due: /^\d{4}-\d{2}-\d{2}$/.test(String(data.due)) ? data.due : null,
    account: typeof data.account === 'string' && data.account ? data.account.slice(0, 60) : null,
    tag: data.tag === '독촉' || data.tag === '압류예고' ? data.tag : '',
    usage: data.usage && Number.isFinite(Number(data.usage.value)) ? { value: Number(data.usage.value), unit: String(data.usage.unit || '').slice(0, 6) } : null,
  };
  return json(res, 200, { ok: true, data: clean });
};
