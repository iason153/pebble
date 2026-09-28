'use strict';

/**
 * Lineup 공유하기 — 앱 화면·사용법 페이지 공용
 *
 * - 휴대폰: 기본 공유 창(navigator.share)을 띄워 카톡·문자·밴드 등으로 바로 보냄
 * - 공유 창이 없는 곳(일부 PC, 카톡 안 브라우저 등): 주소를 복사하고 안내
 * - 공유 링크에는 utm 꼬리표를 붙여 GA4에서 "공유로 들어온 방문"을 따로 집계
 *   (utm_source=share, utm_medium=referral, utm_content=어디서 눌렀는지)
 */
window.LineupShare = (function () {
  const TITLE = 'Lineup — 유튜브 영상을 순서대로, 가는 동안 볼 만큼만';
  const TEXT = '보고 싶은 유튜브 영상을 순서대로 담아두고, 출퇴근길에 한 번에 이어보는 무료 도구예요.';

  function shareUrl(source) {
    const u = new URL('https://pebbleitgo.com/lineup/');
    u.searchParams.set('utm_source', 'share');
    u.searchParams.set('utm_medium', 'referral');
    u.searchParams.set('utm_campaign', 'app_share');
    u.searchParams.set('utm_content', source || 'app');
    return u.toString();
  }

  function track(name, params) {
    if (typeof window.lineupTrack === 'function') window.lineupTrack(name, params);
  }

  /** 앱 화면엔 토스트가 이미 있고, 사용법 페이지엔 없으니 필요하면 간단히 만든다 */
  function notify(message) {
    if (window.LineupApp && typeof window.LineupApp.showToast === 'function') {
      window.LineupApp.showToast(message, { duration: 3500 });
      return;
    }
    let el = document.getElementById('share-toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'share-toast';
      el.className = 'toast';
      el.setAttribute('role', 'status');
      el.innerHTML = '<span class="toast__msg"></span>';
      el.style.bottom = 'calc(20px + env(safe-area-inset-bottom))';
      document.body.appendChild(el);
    }
    el.querySelector('.toast__msg').textContent = message;
    el.hidden = false;
    requestAnimationFrame(() => el.classList.add('is-visible'));
    clearTimeout(el._t);
    el._t = setTimeout(() => el.classList.remove('is-visible'), 3500);
  }

  async function copy(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (_) {
      // 구형·앱 안 브라우저용: 임시 입력창을 만들어 복사
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

  /**
   * @param {string} source 어디서 눌렀는지 (header / guide / …) — 통계용
   */
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
          return; // 사용자가 공유 창을 닫음 — 조용히 끝
        }
        // 그 밖의 실패(권한 등)는 복사로 대체
      }
    }

    const ok = await copy(`${TEXT}\n${url}`);
    track('app_share', { method: 'copy', source, outcome: ok ? 'copied' : 'fail' });
    notify(
      ok
        ? '소개 문구와 주소를 복사했어요. 카톡이나 문자에 붙여넣어 보내주세요.'
        : `이 주소를 복사해서 보내주세요: pebbleitgo.com/lineup`
    );
  }

  return { share, shareUrl };
})();
