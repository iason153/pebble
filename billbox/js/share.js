'use strict';

/**
 * Billbox 공유하기 (Getset share.js 재사용)
 * - 휴대폰: 기본 공유 창(navigator.share) → 카톡·문자·밴드 등
 * - 공유 창이 없는 곳: 소개 문구+주소 복사 후 안내
 * - 링크에 utm 꼬리표(utm_source=share)를 붙여 GA4에서 공유 유입을 따로 집계
 */
window.BillboxShare = (function () {
  const TITLE = 'Billbox — 고지서 찍으면 마감 알림';
  const TEXT = '고지서를 찍기만 하면 얼마를 언제까지 내야 하는지 읽어서 마감 전에 알려 주는 무료 도구예요. 독촉장 안 받게!';

  function shareUrl(source) {
    const u = new URL('https://pebbleitgo.com/billbox/');
    u.searchParams.set('utm_source', 'share');
    u.searchParams.set('utm_medium', 'referral');
    u.searchParams.set('utm_campaign', 'app_share');
    u.searchParams.set('utm_content', source || 'app');
    return u.toString();
  }

  function track(name, params) {
    if (typeof window.pebbleTrack === 'function') window.pebbleTrack(name, params);
  }

  function notify(message) {
    if (window.BillboxApp && typeof window.BillboxApp.showToast === 'function') {
      window.BillboxApp.showToast(message, { duration: 3500 });
    }
  }

  async function copy(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (_) {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      let ok = false;
      try {
        ok = document.execCommand('copy');
      } catch (_) {}
      ta.remove();
      return ok;
    }
  }

  async function share(source) {
    const url = shareUrl(source);
    if (navigator.share) {
      try {
        await navigator.share({ title: TITLE, text: TEXT, url });
        track('app_share', { method: 'native', source, outcome: 'shared' });
        notify('공유해 주셔서 고마워요!');
        return;
      } catch (err) {
        if (err && err.name === 'AbortError') {
          track('app_share', { method: 'native', source, outcome: 'cancel' });
          return;
        }
      }
    }
    const ok = await copy(`${TEXT}\n${url}`);
    track('app_share', { method: 'copy', source, outcome: ok ? 'copied' : 'fail' });
    notify(ok ? '소개 문구와 주소를 복사했어요. 카톡이나 문자에 붙여넣어 보내주세요.' : '이 주소를 복사해서 보내주세요: pebbleitgo.com/billbox');
  }

  return { share, shareUrl };
})();
