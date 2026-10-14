'use strict';

/**
 * Billbox 서버 공용 — Upstash Redis(REST) + Web Push
 *
 * 저장하는 것: 기기키별 { sub(푸시 구독), hour, days, items:[{id,name,due}], updatedAt }
 * 저장하지 않는 것: 금액·주소·납부자번호·사진 (클라이언트가 애초에 보내지 않음)
 *
 * 환경변수(Vercel → Settings → Environment Variables):
 *   UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN  — Vercel Marketplace에서 Upstash 연결 시 자동 생성
 *   VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT(mailto:…)
 *   CRON_SECRET — Vercel이 cron 호출 시 Authorization: Bearer 로 보냄
 */
const webpush = require('web-push');

// Vercel 마켓플레이스에서 Upstash를 연결하면 UPSTASH_REDIS_REST_* 또는 KV_REST_API_* 이름으로 들어온다 → 둘 다 지원
const URL_ = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;

async function redis(...cmd) {
  if (!URL_ || !TOKEN) throw new Error('Redis 환경변수(UPSTASH_REDIS_REST_URL 또는 KV_REST_API_URL)가 없어요');
  const r = await fetch(URL_, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify(cmd) });
  const j = await r.json();
  if (j.error) throw new Error(j.error);
  return j.result;
}

const KEY = (k) => `bb:dev:${k}`;
const SET = 'bb:devices';

async function getDevice(key) {
  const raw = await redis('GET', KEY(key));
  return raw ? JSON.parse(raw) : null;
}
async function putDevice(key, data) {
  await redis('SET', KEY(key), JSON.stringify(data));
  await redis('SADD', SET, key);
}
async function delDevice(key) {
  await redis('DEL', KEY(key));
  await redis('SREM', SET, key);
}
async function allDeviceKeys() {
  return (await redis('SMEMBERS', SET)) || [];
}

function vapid() {
  const pub = process.env.VAPID_PUBLIC_KEY;
  const priv = process.env.VAPID_PRIVATE_KEY;
  if (!pub || !priv) throw new Error('VAPID 키가 없어요');
  webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:creatorock153@gmail.com', pub, priv);
  return pub;
}

/** 푸시 1건. 구독이 죽었으면(410/404) false → 기기 삭제용 */
async function send(sub, payload) {
  vapid();
  try {
    await webpush.sendNotification(sub, JSON.stringify(payload), { TTL: 60 * 60 * 12 });
    return true;
  } catch (e) {
    if (e.statusCode === 404 || e.statusCode === 410) return false;
    throw e;
  }
}

function json(res, status, body) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.status(status).send(JSON.stringify(body));
}

function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  try {
    return JSON.parse(req.body || '{}');
  } catch (_) {
    return {};
  }
}

/** 한국 시간 기준 오늘 'YYYY-MM-DD'와 시(hour) */
function kstNow() {
  const d = new Date(Date.now() + 9 * 3600 * 1000);
  const p2 = (n) => String(n).padStart(2, '0');
  return { date: `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}`, hour: d.getUTCHours() };
}
function addDays(ymd, n) {
  const [y, m, d] = ymd.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  const p2 = (k) => String(k).padStart(2, '0');
  return `${t.getUTCFullYear()}-${p2(t.getUTCMonth() + 1)}-${p2(t.getUTCDate())}`;
}

module.exports = { redis, getDevice, putDevice, delDevice, allDeviceKeys, vapid, send, json, readBody, kstNow, addDays };
