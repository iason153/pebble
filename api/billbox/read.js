'use strict';
const { redis, json, readBody, kstNow } = require('./_lib');

/**
 * POST /api/billbox/read — 고지서 사진을 AI(Claude)로 읽기
 *
 * 받는 것: { deviceKey, image(base64, data: 접두사 없이), mediaType, field? }
 *   - field 없음: 고지서 전체 읽기(종류·금액·기한·계좌·자동이체 여부…)
 *   - field 'amount'|'due'|'account': 콕 찍기 — 잘라낸 조각에서 그 값 하나만
 * 하는 일: 사진을 메모리에서만 들고 Anthropic API에 보내 JSON으로 받는다.
 * 지키는 것:
 *   - 사진·결과를 어디에도 저장하지 않는다(디스크 X, 로그 X, Redis에는 "몇 번 읽었는지" 숫자만).
 *   - Anthropic 상업 API는 보낸 데이터를 학습에 쓰지 않는다(약관).
 * 정확도: 1차(빠른 모델)가 금액·기한을 못 읽으면 2차(상위 모델)로 한 번 더 — 못 읽은 경우에만이라 비용 미미.
 * 비용 방어: 기기키당 하루 BILLBOX_AI_DAILY(기본 20)회, 전체 월 BILLBOX_AI_MONTHLY(기본 5000)회. 넘으면 429 → 폰 읽기로.
 * 환경변수: ANTHROPIC_API_KEY(필수), BILLBOX_AI_MODEL(기본 claude-haiku-5-5), BILLBOX_AI_MODEL2(기본 claude-sonnet-5-5), BILLBOX_AI_DAILY, BILLBOX_AI_MONTHLY
 */

const KINDS = ['electric', 'gas', 'water', 'health', 'pension', 'cartax', 'proptax', 'maint', 'telecom', 'rent', 'insurance', 'academy', 'loan', 'subscribe', 'fine', 'transfer', 'etc'];

const PROMPT = `한국의 고지서/청구서/납부 안내 사진이다. 아래 JSON 하나만 출력해라. 설명·코드펜스 금지.
{"doc":true,"issuer":"발행기관(짧게)","kind":"electric|gas|water|health|pension|cartax|proptax|maint|telecom|rent|insurance|academy|loan|subscribe|fine|etc","name":"짧은 항목 이름(예: 전기요금, 수도요금, 건강보험)","amount":납기내_청구금액_숫자,"amountLate":납기후_금액_숫자_또는_null,"due":"납부기한 YYYY-MM-DD","account":"은행이름 계좌번호(가상계좌 포함, 없으면 null)","autopay":true_또는_false,"tag":"독촉|압류예고|(해당 없으면 빈 문자열)","usage":{"value":숫자,"unit":"kWh|m3"} 또는 null}
규칙:
- amount는 "납기내" 금액이다. 납기후·연체 금액과 절대 바꾸지 마라. 쉼표 없이 정수.
- due는 "납기내" 기한이다. 납기후 기한이 아니다. 연도가 안 보이면 사진 속 다른 날짜(고지년월 등)로 추정해라. 자동이체 고지서면 출금(인출) 예정일이 due다.
- autopay: "자동이체", "자동납부", "출금예정", "인출예정" 표시가 있거나 자동이체로 출금된다는 안내가 있으면 true.
- 독촉장·체납·압류예고면 tag에 적어라.
- 고지서가 아니면 {"doc":false}만 출력해라.
- 확실하지 않은 값은 null로 둬라. 지어내지 마라.`;

const FIELD_PROMPT = {
  amount: '한국 고지서의 일부분 사진이다. 이 조각에서 "납기내 청구금액"(원)을 찾아 {"value":숫자} JSON 하나만 출력해라. 납기후 금액 말고 납기내. 쉼표 없이 정수. 못 찾으면 {"value":null}.',
  due: '한국 고지서의 일부분 사진이다. 이 조각에서 납부기한(또는 출금 예정일) 날짜를 찾아 {"value":"YYYY-MM-DD"} JSON 하나만 출력해라. 납기후 기한 말고 납기내. 연도가 없으면 조각 안 다른 표기로 추정. 못 찾으면 {"value":null}.',
  account: '한국 고지서의 일부분 사진이다. 이 조각에서 납부 계좌번호(가상계좌 포함)를 찾아 {"value":"은행이름 계좌번호"} JSON 하나만 출력해라. 못 찾으면 {"value":null}.',
};

async function countUp(key, ttlSec) {
  const n = await redis('INCR', key);
  if (Number(n) === 1) await redis('EXPIRE', key, String(ttlSec));
  return Number(n);
}

async function callClaude(apiKey, model, prompt, image, mediaType) {
  const ac = new AbortController();
  const to = setTimeout(() => ac.abort(), 40000);
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: ac.signal,
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        max_tokens: 400,
        temperature: 0,
        messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: mediaType, data: image } }, { type: 'text', text: prompt }] }],
      }),
    });
    const j = await r.json();
    if (!r.ok) return { err: r.status === 429 || r.status === 529 ? 'busy' : 'ai' };
    const out = (j.content || []).map((c) => c.text || '').join('');
    const m = out.match(/\{[\s\S]*\}/);
    return { data: m ? JSON.parse(m[0]) : null };
  } catch (_) {
    return { err: 'ai' };
  } finally {
    clearTimeout(to);
  }
}

function cleanBill(data) {
  return {
    doc: true,
    issuer: typeof data.issuer === 'string' ? data.issuer.slice(0, 40) : '',
    kind: KINDS.includes(data.kind) ? data.kind : 'etc',
    name: typeof data.name === 'string' ? data.name.slice(0, 30) : '',
    amount: Number.isFinite(Number(data.amount)) && Number(data.amount) > 0 && Number(data.amount) < 1e9 ? Math.round(Number(data.amount)) : null,
    amountLate: Number.isFinite(Number(data.amountLate)) && Number(data.amountLate) > 0 ? Math.round(Number(data.amountLate)) : null,
    due: /^\d{4}-\d{2}-\d{2}$/.test(String(data.due)) ? data.due : null,
    account: typeof data.account === 'string' && data.account ? data.account.slice(0, 60) : null,
    autopay: data.autopay === true,
    tag: data.tag === '독촉' || data.tag === '압류예고' ? data.tag : '',
    usage: data.usage && Number.isFinite(Number(data.usage.value)) ? { value: Number(data.usage.value), unit: String(data.usage.unit || '').slice(0, 6) } : null,
  };
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
  if (!image || image.length > 2800000 || !/^[A-Za-z0-9+/=]+$/.test(image.slice(0, 1000))) return json(res, 400, { error: 'image' });
  const field = ['amount', 'due', 'account'].includes(b.field) ? b.field : null;

  // ---- 한도 (숫자만 저장, 사진·내용은 저장 안 함) ----
  const now = kstNow();
  const daily = Number(process.env.BILLBOX_AI_DAILY) || 20;
  const monthly = Number(process.env.BILLBOX_AI_MONTHLY) || 5000;
  try {
    const dCount = await countUp(`bb:ai:d:${dev}:${now.date}`, 2 * 86400);
    if (dCount > daily * (field ? 3 : 1)) return json(res, 429, { error: 'limit_daily' }); // 콕 찍기는 한도 3배(조각이라 저렴)
    const mCount = await countUp(`bb:ai:m:${now.date.slice(0, 7)}`, 40 * 86400);
    if (mCount > monthly) return json(res, 429, { error: 'limit_monthly' });
  } catch (_) {
    // Redis가 잠깐 안 되면 읽기 자체는 계속(한도는 best-effort)
  }

  const model1 = process.env.BILLBOX_AI_MODEL || 'claude-haiku-5-5';
  const model2 = process.env.BILLBOX_AI_MODEL2 || 'claude-sonnet-5-5';

  // ---- 콕 찍기(조각에서 값 하나) ----
  if (field) {
    let r = await callClaude(apiKey, model1, FIELD_PROMPT[field], image, mediaType);
    let v = r.data ? r.data.value : null;
    if ((v == null || v === '') && !r.err && model2 !== model1) {
      r = await callClaude(apiKey, model2, FIELD_PROMPT[field], image, mediaType);
      v = r.data ? r.data.value : null;
    }
    if (r.err) return json(res, 502, { error: r.err });
    if (field === 'amount') v = Number.isFinite(Number(v)) && Number(v) > 0 ? Math.round(Number(v)) : null;
    else if (field === 'due') v = /^\d{4}-\d{2}-\d{2}$/.test(String(v)) ? v : null;
    else v = typeof v === 'string' && v ? v.slice(0, 60) : null;
    return json(res, 200, { ok: true, value: v });
  }

  // ---- 고지서 전체 읽기 (1차, 부족하면 2차) ----
  let r1 = await callClaude(apiKey, model1, PROMPT, image, mediaType);
  if (r1.err && !r1.data) {
    // 1차 모델이 혼잡하면 2차로 한 번
    r1 = await callClaude(apiKey, model2, PROMPT, image, mediaType);
    if (r1.err && !r1.data) return json(res, 502, { error: r1.err });
  }
  let data = r1.data;
  if (!data) return json(res, 502, { error: 'ai' });
  if (data.doc === false) return json(res, 200, { ok: true, data: { doc: false } });
  let clean = cleanBill(data);

  if ((clean.amount == null || clean.due == null) && model2 !== model1) {
    // 핵심 값을 못 읽음 → 상위 모델로 한 번 더(수도요금처럼 작은 색칸 글씨 대비)
    const r2 = await callClaude(apiKey, model2, PROMPT, image, mediaType);
    if (r2.data && r2.data.doc !== false) {
      const c2 = cleanBill(r2.data);
      // 2차가 찾아낸 값으로 빈칸을 채우고, 2차가 더 많이 읽었으면 2차를 믿는다
      const score = (c) => (c.amount != null ? 1 : 0) + (c.due != null ? 1 : 0) + (c.account ? 1 : 0);
      clean = score(c2) > score(clean) ? Object.assign({}, clean, c2) : Object.assign({}, c2, clean, { amount: clean.amount != null ? clean.amount : c2.amount, due: clean.due || c2.due, account: clean.account || c2.account });
      clean.retry = 1;
    }
  }
  return json(res, 200, { ok: true, data: clean });
};
