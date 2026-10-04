'use strict';

/**
 * 무엇이 필요해요? / 이 근처에서 찾기 — 일상에서 자주 찾는 곳
 * 고르면 주변을 찾아 가까운 순 리스트로 보여 주고, 사용자가 고른다.
 *   cat  : 카카오 장소 분류 코드로 찾기
 *   kw   : 분류가 없는 것은 낱말로 찾기
 *   kind : 실질 시간 계산에 쓰는 장소 종류 (data/model.json → kinds). null이면 찾은 장소로 추정
 *   stay : 머무는 시간(분). 없으면 장소 종류의 보통 값
 */
window.GetsetTasks = (function () {
  const LIST = [
    { id: 'pharmacy', label: '약국', icon: '💊', cat: 'PM9', kind: 'pharmacy' },
    { id: 'bank', label: '은행', icon: '🏦', cat: 'BK9', kind: 'bank' },
    { id: 'cash', label: '현금 찾기', icon: '🏧', cat: 'BK9', kind: 'atm' },
    { id: 'cvs', label: '편의점', icon: '🏪', cat: 'CS2', kind: 'local', stay: 5 },
    { id: 'mart', label: '마트·장보기', icon: '🛒', cat: 'MT1', kind: null },
    { id: 'cafe', label: '카페', icon: '☕', cat: 'CE7', kind: 'food', stay: 15 },
    { id: 'meal', label: '식당', icon: '🍚', cat: 'FD6', kind: 'food' },
    { id: 'bakery', label: '빵집', icon: '🥐', kw: '빵집', kind: 'local', stay: 10 },
    { id: 'gas', label: '주유소', icon: '⛽', cat: 'OL7', kind: 'gas' },
    { id: 'clinic', label: '병원·의원', icon: '🏥', cat: 'HP8', kind: 'hospital' },
    { id: 'post', label: '우체국', icon: '📮', kw: '우체국', kind: 'post' },
    { id: 'parcel', label: '택배 보내기', icon: '📦', cat: 'CS2', kind: 'local', stay: 10 },
    { id: 'laundry', label: '세탁소', icon: '🧺', kw: '세탁소', kind: 'local', stay: 5 },
    { id: 'hair', label: '미용실', icon: '💇', kw: '미용실', kind: 'etc', stay: 60 },
    { id: 'daiso', label: '생활용품', icon: '🧴', kw: '다이소', kind: 'local', stay: 15 },
    { id: 'office', label: '주민센터', icon: '🏛', kw: '행정복지센터', kind: 'gov' },
  ];
  const BY = Object.fromEntries(LIST.map((t) => [t.id, t]));
  return { LIST, get: (id) => BY[id] || null };
})();
