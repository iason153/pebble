'use strict';
const { getDevice, putDevice, delDevice, send, json, readBody, kstNow } = require('./_lib');

/**
 * POST   /api/billbox/sync  { deviceKey, subscription, hour, days, items:[{id,name,due}] } → 저장
 * POST   /api/billbox/sync  { deviceKey, test:true } → 시험 알림 1건
 * DELETE /api/billbox/sync  { deviceKey } → 삭제(알림 끄기)
 */
module.exports = async (req, res) => {
  const b = readBody(req);
  const key = String(b.deviceKey || '');
  if (!/^[0-9a-f]{32}$/.test(key)) return json(res, 400, { error: 'deviceKey' });

  if (req.method === 'DELETE') {
    await delDevice(key);
    return json(res, 200, { ok: true });
  }
  if (req.method !== 'POST') return json(res, 405, { error: 'method' });

  if (b.test) {
    const dev = await getDevice(key);
    if (!dev || !dev.sub) return json(res, 404, { error: '먼저 알림을 켜 주세요' });
    // 등록된 항목 중 가장 가까운 것 하나로 "실제로 이렇게 와요"를 보여 줌(금액은 폰이 붙임)
    const today = kstNow().date;
    const dayDiff = (a, b) => Math.round((Date.UTC(...a.split('-').map((v, i) => (i === 1 ? v - 1 : +v))) - Date.UTC(...b.split('-').map((v, i) => (i === 1 ? v - 1 : +v)))) / 86400000);
    const near = (dev.items || []).filter((it) => dayDiff(it.due, today) >= -1).sort((a, b) => (a.due < b.due ? -1 : 1))[0];
    const payload = { title: 'Billbox 시험 알림 🔔', body: '이렇게 알려 드려요. 마감 3일 전·당일 아침에 만나요!', tag: 'billbox-test' };
    if (near) payload.items = [{ id: near.id, name: near.name, days: Math.max(-1, dayDiff(near.due, today)) }];
    const ok = await send(dev.sub, payload);
    return json(res, 200, { ok });
  }

  const sub = b.subscription;
  if (!sub || !sub.endpoint || !/^https:\/\//.test(sub.endpoint)) return json(res, 400, { error: 'subscription' });
  const hour = Math.min(23, Math.max(0, Number(b.hour) || 9));
  const days = Array.isArray(b.days) ? b.days.map(Number).filter((n) => n >= 0 && n <= 30).slice(0, 6) : [3, 0];
  const items = (Array.isArray(b.items) ? b.items : [])
    .slice(0, 200)
    .filter((it) => it && typeof it.id === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(String(it.due)))
    .map((it) => ({ id: String(it.id).slice(0, 40), name: String(it.name || '').slice(0, 40), due: it.due, auto: it.auto ? 1 : 0 }));
  const prev = (await getDevice(key)) || {};
  await putDevice(key, { sub, hour, days: days.length ? days : [3, 0], items, sent: prev.sent || {}, updatedAt: Date.now() });
  json(res, 200, { ok: true, items: items.length });
};
