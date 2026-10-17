'use strict';

/**
 * Billbox 푸시 알림(Web Push) — 서버(/api/billbox)와 주고받는 유일한 부분.
 *
 * 서버에 올라가는 것: 익명 기기키, 푸시 구독 주소, 알림 시각, 항목의 [이름·마감일]만.
 * 올라가지 않는 것: 금액, 납부자번호, 주소, 사진. (알림 문구에 금액이 안 나오는 이유)
 *
 * - 갤럭시 크롬·삼성인터넷: 바로 됨. 아이폰: "홈 화면에 추가" 뒤에만 됨(iOS 16.4+, 미확인).
 * - 항목이 바뀔 때마다 sync()로 목록을 다시 올린다(1초 모아서 한 번).
 */
window.BillboxPush = (function () {
  const cfg = () => window.BILLBOX_CONFIG || {};
  const S = () => window.BillboxStore;
  let syncTimer = null;

  function supported() {
    return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window && !!cfg().API_BASE;
  }
  function iosNeedsInstall(env) {
    return env && env.ios && !env.standalone;
  }

  function deviceKey() {
    const s = S().settings();
    if (s.deviceKey) return s.deviceKey;
    const arr = new Uint8Array(16);
    crypto.getRandomValues(arr);
    const key = Array.from(arr, (b) => b.toString(16).padStart(2, '0')).join('');
    S().saveSettings({ deviceKey: key });
    return key;
  }

  function urlB64ToU8(b64) {
    const pad = '='.repeat((4 - (b64.length % 4)) % 4);
    const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from(raw, (c) => c.charCodeAt(0));
  }

  async function api(path, opts) {
    const res = await fetch(cfg().API_BASE + path, Object.assign({ headers: { 'Content-Type': 'application/json' } }, opts));
    if (!res.ok) throw new Error('서버 응답 오류 ' + res.status);
    return res.json();
  }

  /** 서버에 올릴 목록: 이름·마감일만 */
  function payloadItems() {
    return S()
      .load()
      .filter((x) => !x.paidAt)
      .map((x) => ({ id: x.id, name: x.name || window.BillboxKinds.byId(x.kindId).label, due: x.due, auto: x.auto ? 1 : 0 }));
  }

  async function enable() {
    if (!supported()) throw new Error('이 브라우저는 알림을 지원하지 않아요');
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') throw new Error('알림 권한이 꺼져 있어요. 브라우저 설정에서 켜 주세요');
    const reg = await navigator.serviceWorker.ready;
    const { publicKey } = await api('/config');
    let sub = await reg.pushManager.getSubscription();
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToU8(publicKey) });
    const s = S().settings();
    await api('/sync', { method: 'POST', body: JSON.stringify({ deviceKey: deviceKey(), subscription: sub.toJSON(), hour: s.remindHour, days: s.remindDays, items: payloadItems() }) });
    S().saveSettings({ push: 'on' });
    return true;
  }

  async function disable() {
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) await sub.unsubscribe();
    } catch (_) {}
    try {
      await api('/sync', { method: 'DELETE', body: JSON.stringify({ deviceKey: deviceKey() }) });
    } catch (_) {}
    S().saveSettings({ push: 'off' });
  }

  /** 항목·설정이 바뀌면 호출. 푸시가 켜져 있을 때만 서버에 다시 올림 */
  function sync() {
    if (S().settings().push !== 'on' || !supported()) return;
    clearTimeout(syncTimer);
    syncTimer = setTimeout(async () => {
      try {
        const reg = await navigator.serviceWorker.ready;
        const sub = await reg.pushManager.getSubscription();
        if (!sub) return;
        const s = S().settings();
        await api('/sync', { method: 'POST', body: JSON.stringify({ deviceKey: deviceKey(), subscription: sub.toJSON(), hour: s.remindHour, days: s.remindDays, items: payloadItems() }) });
      } catch (_) {
        /* 서버가 잠깐 안 돼도 앱은 계속 동작 */
      }
    }, 1000);
  }

  /** 지금 알림 한 번 보내보기(설정 화면 "시험 알림") */
  async function test() {
    return api('/sync', { method: 'POST', body: JSON.stringify({ deviceKey: deviceKey(), test: true }) });
  }

  return { supported, iosNeedsInstall, enable, disable, sync, test, deviceKey };
})();
