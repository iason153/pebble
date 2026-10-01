'use strict';

/**
 * 실행 환경 판별 + 홈 화면 설치 안내 + 앱 안 브라우저 안내
 * (Lineup app.js의 Env·설치 시트를 툴 공용으로 떼어낸 것)
 *
 * 사용: GetsetInstall.init({ appName, track, showToast, openSheet, closeSheet })
 */
window.GetsetEnv = {
  IN_APPS: [
    { id: 'kakao', name: '카카오톡', re: /KAKAOTALK/i },
    { id: 'naver', name: '네이버 앱', re: /NAVER\(inapp|NAVER\//i },
    { id: 'band', name: '밴드', re: /BAND\//i },
    { id: 'instagram', name: '인스타그램', re: /Instagram/i },
    { id: 'facebook', name: '페이스북', re: /FBAN|FBAV|FB_IAB/i },
    { id: 'line', name: '라인', re: /\bLine\//i },
    { id: 'daum', name: '다음 앱', re: /DaumApps/i },
  ],

  detect() {
    const ua = navigator.userAgent || '';
    const ios = /iP(hone|od|ad)/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    const android = /Android/i.test(ua);
    const inApp = this.IN_APPS.find((a) => a.re.test(ua)) || null;
    let browser = 'other';
    if (/SamsungBrowser/i.test(ua)) browser = 'samsung';
    else if (/CriOS/i.test(ua)) browser = 'chrome-ios';
    else if (/FxiOS|Firefox/i.test(ua)) browser = 'firefox';
    else if (/Edg/i.test(ua)) browser = 'edge';
    else if (/Chrome/i.test(ua)) browser = 'chrome';
    else if (ios && /Safari/i.test(ua)) browser = 'safari';
    const standalone =
      (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) ||
      window.navigator.standalone === true;
    const platform = ios ? 'ios' : android ? 'android' : 'desktop';
    return { ios, android, platform, inApp, browser, standalone };
  },

  /** 앱 안 브라우저에서 바깥 브라우저로 여는 주소 (없으면 null → 메뉴 안내) */
  externalOpenUrl(env, url) {
    if (!env.inApp) return null;
    if (env.inApp.id === 'kakao') return `kakaotalk://web/openExternal?url=${encodeURIComponent(url)}`;
    if (env.android) {
      const u = new URL(url);
      return `intent://${u.host}${u.pathname}${u.search}#Intent;scheme=https;package=com.android.chrome;end`;
    }
    return null;
  },
};

window.GetsetInstall = (function () {
  const $ = (id) => document.getElementById(id);
  let o = null; // init 옵션
  let env = null;
  let installPrompt = null;
  let primary = null;

  function appUrl() {
    return new URL('./', window.location.href).toString();
  }

  function init(opts) {
    o = opts;
    env = window.GetsetEnv.detect();
    const btn = $('btn-install');
    const sheet = $('install-sheet');

    if (env.standalone) return env; // 이미 홈 화면 앱

    btn.hidden = false;
    btn.addEventListener('click', open);
    sheet.addEventListener('click', (e) => {
      if (e.target.closest('[data-close]')) o.closeSheet(sheet);
      const c = e.target.closest('[data-copy-url]');
      if (c) copyUrl(c);
    });
    $('btn-install-primary').addEventListener('click', () => {
      if (!primary) return;
      o.track('install_primary_click', { label: primary.label });
      primary.action();
    });

    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      installPrompt = e;
      o.track('install_available');
      if (!sheet.hidden) render();
    });
    window.addEventListener('appinstalled', () => {
      btn.hidden = true;
      o.closeSheet(sheet);
      o.track('app_installed');
      o.showToast(`설치됐어요! 홈 화면의 ${o.appName} 아이콘으로 열어보세요`, { duration: 5000 });
    });

    if (env.inApp) wireInAppBanner();
    return env;
  }

  function wireInAppBanner() {
    const banner = $('inapp-banner');
    let dismissed = false;
    try {
      dismissed = sessionStorage.getItem('getset:inapp-dismissed') === '1';
    } catch (_) {}
    const target = env.ios ? '사파리' : '크롬';
    const targetRo = env.ios ? '사파리로' : '크롬으로';
    $('inapp-name').textContent = env.inApp.name;
    $('inapp-target').textContent = target;
    const ext = window.GetsetEnv.externalOpenUrl(env, window.location.href);
    const openBtn = $('btn-inapp-open');
    openBtn.textContent = ext ? `${targetRo} 열기` : '여는 방법';
    banner.hidden = dismissed;
    openBtn.addEventListener('click', () => {
      o.track('inapp_open_click', { app: env.inApp.id, direct: !!ext });
      if (ext) window.location.href = ext;
      else open();
    });
    $('btn-inapp-close').addEventListener('click', () => {
      banner.hidden = true;
      try {
        sessionStorage.setItem('getset:inapp-dismissed', '1');
      } catch (_) {}
    });
    o.track('inapp_detected', { app: env.inApp.id });
  }

  function open() {
    render();
    o.openSheet($('install-sheet'));
    o.track('install_sheet_open', {
      platform: env.platform,
      browser: env.browser,
      in_app: env.inApp ? env.inApp.id : 'none',
      can_prompt: !!installPrompt,
    });
  }

  function render() {
    const name = o.appName;
    const title = $('install-sheet-title');
    const I = {
      share: '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M12 3v12M7.5 7.5 12 3l4.5 4.5M6 11H5a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-8a1 1 0 0 0-1-1h-1"/></svg>',
      dots: '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><circle cx="12" cy="5" r="2" fill="currentColor"/><circle cx="12" cy="12" r="2" fill="currentColor"/><circle cx="12" cy="19" r="2" fill="currentColor"/></svg>',
      hdots: '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><circle cx="5" cy="12" r="2" fill="currentColor"/><circle cx="12" cy="12" r="2" fill="currentColor"/><circle cx="19" cy="12" r="2" fill="currentColor"/></svg>',
      menu: '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" d="M4 7h16M4 12h16M4 17h16"/></svg>',
      plus: '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><rect x="4" y="4" width="16" height="16" rx="4" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 8v8M8 12h8" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
    };
    const chip = (label, icon = '') => `<span class="ui-chip">${icon}${label}</span>`;
    const copyBox = () => `
      <div class="install-copy">
        <input type="text" readonly value="${appUrl()}" aria-label="${name} 주소">
        <button type="button" data-copy-url>주소 복사</button>
      </div>`;

    let desc = '';
    let steps = [];
    let note = '';
    let extra = '';
    primary = null;

    if (env.inApp) {
      const target = env.ios ? '사파리' : '크롬';
      const targetRo = env.ios ? '사파리로' : '크롬으로';
      const ext = window.GetsetEnv.externalOpenUrl(env, window.location.href);
      title.textContent = `먼저 ${targetRo} 열어주세요`;
      desc = `지금은 ${env.inApp.name} 안에서 열려 있어서 설치가 안 돼요. ${targetRo} 연 다음 다시 "설치"를 눌러주세요.`;
      if (ext) {
        primary = { label: `${targetRo} 열기`, action: () => (window.location.href = ext) };
        steps = [`아래 ${chip(`${targetRo} 열기`)} 버튼을 눌러요.`, `${target}에서 ${name}이 열리면 오른쪽 위 ${chip('설치')}를 다시 눌러요.`];
      } else {
        steps = env.ios
          ? [`화면 오른쪽 아래(또는 위)의 ${chip('', I.hdots)} 또는 ${chip('', I.share)} 버튼을 눌러요.`, `${chip('Safari로 열기')} (또는 "기본 브라우저로 열기")를 눌러요.`, `사파리에서 ${name}이 열리면 ${chip('설치')}를 다시 눌러요.`]
          : [`화면 오른쪽 위의 ${chip('', I.dots)} 버튼을 눌러요.`, `${chip('다른 브라우저로 열기')} (또는 "Chrome으로 열기")를 눌러요.`, `크롬에서 ${name}이 열리면 ${chip('설치')}를 다시 눌러요.`];
      }
      note = '메뉴가 안 보이면 아래 주소를 복사해서 크롬·사파리 주소창에 붙여넣어도 돼요.';
      extra = copyBox();
    } else if (installPrompt) {
      title.textContent = `홈 화면에 ${name} 설치하기`;
      desc = `버튼 한 번이면 끝나요. 홈 화면에 ${name} 아이콘이 생겨요.`;
      primary = { label: '지금 설치하기', action: promptInstall };
      steps = [`아래 ${chip('지금 설치하기')}를 눌러요.`, `뜨는 창에서 ${chip('설치')}를 눌러요.`];
    } else if (env.ios) {
      title.textContent = '아이폰 홈 화면에 추가하기';
      desc = env.browser === 'safari' ? '사파리에서 세 번만 누르면 돼요.' : '브라우저의 공유 버튼에서 추가할 수 있어요.';
      steps = env.browser === 'safari'
        ? [`화면 아래 가운데 ${chip('', I.share)} 공유 버튼을 눌러요. (안 보이면 화면을 살짝 위로 올려보세요)`, `목록을 아래로 내려 ${chip('홈 화면에 추가', I.plus)}를 눌러요.`, `오른쪽 위 ${chip('추가')}를 눌러요.`]
        : [`주소창 옆의 ${chip('', I.share)} 공유 버튼을 눌러요.`, `${chip('홈 화면에 추가', I.plus)}를 눌러요.`, `${chip('추가')}를 눌러요.`];
    } else if (env.android && env.browser === 'samsung') {
      title.textContent = '갤럭시 홈 화면에 추가하기';
      desc = '삼성 인터넷에서 추가하는 방법이에요.';
      steps = [`화면 아래 오른쪽 ${chip('', I.menu)} 메뉴를 눌러요.`, `${chip('현재 페이지 추가')} (또는 "페이지 추가")를 눌러요.`, `${chip('홈 화면')}을 고르고 ${chip('추가')}를 눌러요.`];
      note = '주소창에 ⬇ 모양 설치 아이콘이 보이면 그걸 눌러도 돼요. 메뉴 이름은 버전에 따라 조금 달라요.';
    } else if (env.android) {
      title.textContent = `홈 화면에 ${name} 설치하기`;
      desc = '크롬 메뉴에서 추가할 수 있어요.';
      steps = [`화면 오른쪽 위 ${chip('', I.dots)} 메뉴를 눌러요.`, `${chip('홈 화면에 추가')} 또는 ${chip('앱 설치')}를 눌러요.`, `${chip('설치')} (또는 "추가")를 눌러요.`];
      note = `이미 설치했다면 홈 화면의 ${name} 아이콘으로 열어주세요.`;
    } else {
      title.textContent = '휴대폰에서 쓰면 더 편해요';
      desc = `${name}은 밖에서 볼일 보는 날 휴대폰으로 쓰도록 만들었어요. 아래 주소를 휴대폰으로 보내서 열어보세요.`;
      steps = ['휴대폰 크롬(아이폰은 사파리)에서 아래 주소를 열어요.', `오른쪽 위 ${chip('설치')}를 누르면 기기에 맞는 방법이 나와요.`];
      note = 'PC 크롬에서도 주소창 오른쪽의 설치 아이콘으로 설치할 수 있어요.';
      extra = copyBox();
    }

    $('install-sheet-desc').textContent = desc;
    $('install-sheet-body').innerHTML =
      `<ol class="install-steps">${steps.map((t) => `<li><span>${t}</span></li>`).join('')}</ol>` +
      (note ? `<p class="install-note">${note}</p>` : '') +
      extra;
    const pb = $('btn-install-primary');
    pb.hidden = !primary;
    if (primary) pb.textContent = primary.label;
  }

  async function promptInstall() {
    if (!installPrompt) return;
    installPrompt.prompt();
    try {
      const choice = await installPrompt.userChoice;
      o.track('install_click', { outcome: (choice && choice.outcome) || 'unknown' });
    } catch (_) {}
    installPrompt = null;
    if (!$('install-sheet').hidden) render();
  }

  async function copyUrl(btn) {
    const url = appUrl();
    let ok = false;
    try {
      await navigator.clipboard.writeText(url);
      ok = true;
    } catch (_) {
      const input = btn.parentElement.querySelector('input');
      input.focus();
      input.select();
      try {
        ok = document.execCommand('copy');
      } catch (_) {}
    }
    btn.textContent = ok ? '복사됨' : '길게 눌러 복사';
    o.track('install_copy_url', { ok });
  }

  return { init, open };
})();
