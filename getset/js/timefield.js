'use strict';

/**
 * 숫자로 시각 넣기 — [오전|오후] [ 2 ]시 [ 30 ]분
 * (2026-10-01 대표 피드백: 시계 그림 대신 숫자 입력)
 *
 * - 휴대폰 숫자 자판이 뜬다 (inputmode=numeric)
 * - "14"처럼 24시간으로 넣어도 알아서 오후 2시로 바꿈
 * - 시를 다 넣으면(두 자리, 또는 2~9 한 자리) 자동으로 분 칸으로 넘어감
 */
window.GetsetTimeField = function (root, { onChange } = {}) {
  const apBtns = root.querySelectorAll('[data-ap]');
  const hIn = root.querySelector('.tf__h');
  const mIn = root.querySelector('.tf__m');
  let ap = 'am';

  function setAp(v) {
    ap = v;
    apBtns.forEach((b) => b.setAttribute('aria-checked', String(b.dataset.ap === v)));
  }

  function digits(el) {
    const v = el.value.replace(/\D/g, '').slice(0, 2);
    if (v !== el.value) el.value = v;
    return v;
  }

  apBtns.forEach((b) =>
    b.addEventListener('click', () => {
      setAp(b.dataset.ap);
      changed();
    })
  );

  hIn.addEventListener('input', () => {
    const v = digits(hIn);
    const n = Number(v);
    if (v.length === 2 && n >= 13 && n <= 23) {
      hIn.value = String(n - 12);
      setAp('pm');
    } else if (v.length === 2 && n === 0) {
      hIn.value = '12';
      setAp('am');
    }
    if (v.length === 2 || (v.length === 1 && n >= 2)) {
      mIn.focus();
      mIn.select();
    }
    changed();
  });
  mIn.addEventListener('input', () => {
    digits(mIn);
    changed();
  });
  mIn.addEventListener('blur', () => {
    if (mIn.value.length === 1) mIn.value = '0' + mIn.value;
  });
  // 칸을 누르면 안의 숫자를 통째로 골라 바로 덮어쓰게 함.
  // (늦게 실행될 때 이미 다른 칸으로 넘어갔다면 건드리지 않아야 숫자가 엉뚱한 칸에 들어가지 않음)
  [hIn, mIn].forEach((el) =>
    el.addEventListener('focus', () =>
      setTimeout(() => {
        if (document.activeElement === el) el.select();
      }, 0)
    )
  );

  function changed() {
    if (onChange) onChange(get());
  }

  /** @returns {string|null} "HH:MM" 또는 잘못된 값이면 null */
  function get() {
    const h = Number(hIn.value);
    const mRaw = mIn.value === '' ? '0' : mIn.value;
    const m = Number(mRaw);
    if (hIn.value === '' || !Number.isInteger(h) || h < 1 || h > 12) return null;
    if (!Number.isInteger(m) || m < 0 || m > 59) return null;
    const H = ap === 'am' ? (h === 12 ? 0 : h) : h === 12 ? 12 : h + 12;
    return `${String(H).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  }

  /** @param {string|null} v "HH:MM" */
  function set(v) {
    if (!v || !/^\d{2}:\d{2}$/.test(v)) {
      hIn.value = '';
      mIn.value = '';
      setAp('am');
      return;
    }
    const [H, M] = v.split(':').map(Number);
    setAp(H < 12 ? 'am' : 'pm');
    hIn.value = String(H % 12 === 0 ? 12 : H % 12);
    mIn.value = String(M).padStart(2, '0');
  }

  function focus() {
    hIn.focus();
  }

  setAp('am');
  return { get, set, focus };
};
