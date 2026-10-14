'use strict';
const { getDevice, putDevice, delDevice, allDeviceKeys, send, json, kstNow, addDays } = require('./_lib');

/**
 * GET /api/billbox/send — Vercel Cron이 매시 정각에 호출(vercel.json).
 * 한국 시간 "지금 시"가 기기의 알림 시각과 같을 때만, 그 기기의 항목을 보고
 *   - 마감 N일 전(설정한 days) · 마감 당일 · 마감 다음날(한 번 더) 알림을 보낸다.
 * 같은 항목·같은 날에는 한 번만(sent 기록). 죽은 구독은 지운다.
 * 수동 시험: /api/billbox/send?force=1&hour=9 (CRON_SECRET 필요)
 */
module.exports = async (req, res) => {
  const auth = req.headers.authorization || '';
  if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) return json(res, 401, { error: 'unauthorized' });

  const now = kstNow();
  const q = req.query || {};
  const hourNow = q.hour != null ? Number(q.hour) : now.hour;
  const force = q.force === '1';
  const keys = await allDeviceKeys();
  let devices = 0;
  let pushed = 0;
  let removed = 0;

  for (const key of keys) {
    const dev = await getDevice(key);
    if (!dev || !dev.sub) continue;
    if (!force && Number(dev.hour) !== hourNow) continue;
    devices++;
    const days = dev.days && dev.days.length ? dev.days : [3, 0];
    const sent = dev.sent || {};
    const lines = [];
    const stamps = [];
    for (const it of dev.items || []) {
      let kind = null;
      for (const n of days) if (addDays(now.date, n) === it.due) kind = n === 0 ? '오늘까지!' : `${n}일 남았어요`;
      if (!kind && addDays(now.date, -1) === it.due) kind = '어제가 마감이었어요. 늦었지만 지금 내면 독촉장은 막아요';
      if (!kind) continue;
      const stamp = `${it.id}:${it.due}:${kind}`;
      if (sent[stamp]) continue;
      sent[stamp] = now.date;
      stamps.push(stamp);
      lines.push(`${it.name || '낼 것'} — ${kind}`);
    }
    // 오래된 sent 기록 정리(60일)
    for (const k of Object.keys(sent)) if (addDays(sent[k], 60) < now.date) delete sent[k];
    if (!lines.length) {
      await putDevice(key, Object.assign(dev, { sent }));
      continue;
    }
    const payload = { title: lines.length === 1 ? '💸 Billbox' : `💸 Billbox · ${lines.length}건`, body: lines.slice(0, 4).join('\n') + (lines.length > 4 ? `\n외 ${lines.length - 4}건` : ''), tag: 'billbox-due' };
    let ok = true;
    try {
      ok = await send(dev.sub, payload);
    } catch (e) {
      ok = true; // 일시 오류면 다음 시간에 다시
      for (const st of stamps) delete sent[st];
    }
    if (!ok) {
      await delDevice(key);
      removed++;
      continue;
    }
    pushed++;
    await putDevice(key, Object.assign(dev, { sent }));
  }
  json(res, 200, { ok: true, at: now, devices, pushed, removed });
};
