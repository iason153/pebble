'use strict';
const { json } = require('./_lib');

/** GET /api/billbox/config → { publicKey } (VAPID 공개키는 공개해도 되는 값) */
module.exports = async (req, res) => {
  const pub = process.env.VAPID_PUBLIC_KEY || '';
  if (!pub) return json(res, 503, { error: '푸시 서버가 아직 설정되지 않았어요' });
  json(res, 200, { publicKey: pub });
};
