'use strict';
/**
 * Seal 공유하기 (Getset share.js와 같은 방식)
 * - 휴대폰: 기본 공유 창(navigator.share) → 카톡·문자·밴드 등
 * - 공유 창이 없는 곳: 소개 문구+주소 복사 후 안내
 * - 링크에 utm 꼬리표(utm_source=share)를 붙여 GA4에서 공유 유입을 따로 집계
 */
window.SealShare = (function () {
  const TITLE = 'Seal — 올리기 전에, 내 사진 지키기';
  const TEXT = 'SNS에 올리기 전 번호판·문패를 가리고 보이지 않는 도장을 심어 주는 무료 도구예요. 사칭 계정에 내 사진이 올라가도 내 것임을 확인할 수 있어요. 사진은 폰 밖으로 안 나가요.';

  function shareUrl(source) {
    const u = new URL('https://pebbleitgo.com/seal/');
    u.searchParams.set('utm_source', 'share');
    u.searchParams.set('utm_medium', 'referral');
    u.searchParams.set('utm_campaign', 'app_share');
    u.searchParams.set('utm_content', source || 'app');
    return u.toString();
  }
  function track(name, params) { if (typeof window.pebbleTrack === 'function') window.pebbleTrack(name, params); }
  function notify(message) { if (window.SealApp && typeof window.SealApp.showToast === 'function') window.SealApp.showToast(message, { duration: 3500 }); }

  async function copy(text) {
    try { await navigator.clipboard.writeText(text); return true; }
    catch (_) {
      const ta = document.createElement('textarea');
      ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      let ok = false; try { ok = document.execCommand('copy'); } catch (_) {}
      ta.remove(); return ok;
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
        if (err && err.name === 'AbortError') { track('app_share', { method: 'native', source, outcome: 'cancel' }); return; }
      }
    }
    const ok = await copy(`${TEXT}\n${url}`);
    track('app_share', { method: 'copy', source, outcome: ok ? 'copied' : 'fail' });
    notify(ok ? '소개 문구와 주소를 복사했어요. 카톡이나 문자에 붙여넣어 보내주세요.' : '이 주소를 복사해서 보내주세요: pebbleitgo.com/seal');
  }
  return { share, shareUrl, copy };
})();
