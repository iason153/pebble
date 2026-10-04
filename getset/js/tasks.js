'use strict';

/**
 * 할 일 넣기 — "어디든 되는 일" (약국·주유·현금 찾기…)
 * 장소를 사용자가 고르지 않는다. 그날 동선에서 가장 덜 돌아가는 곳을 앱이 골라 준다.
 *   cat  : 카카오 장소 분류 코드 (근처 검색)
 *   kind : 실질 시간 계산에 쓰는 장소 종류 (data/model.json → kinds). null이면 찾은 장소로 추정
 *   stay : 머무는 시간(분). 없으면 장소 종류의 보통 값
 */
window.GetsetTasks = (function () {
  const LIST = [
    { id: 'pharmacy', label: '약국', icon: '💊', cat: 'PM9', kind: 'pharmacy' },
    { id: 'cash', label: '현금 찾기', icon: '🏧', cat: 'BK9', kind: 'atm' },
    { id: 'gas', label: '주유', icon: '⛽', cat: 'OL7', kind: 'gas' },
    { id: 'parcel', label: '택배 보내기', icon: '📦', cat: 'CS2', kind: 'local', stay: 10 },
    { id: 'cvs', label: '편의점', icon: '🏪', cat: 'CS2', kind: 'local', stay: 5 },
    { id: 'cafe', label: '커피 사기', icon: '☕', cat: 'CE7', kind: 'food', stay: 10 },
    { id: 'mart', label: '장보기', icon: '🛒', cat: 'MT1', kind: null },
    { id: 'meal', label: '밥 먹기', icon: '🍚', cat: 'FD6', kind: 'food' },
  ];
  const BY = Object.fromEntries(LIST.map((t) => [t.id, t]));
  return { LIST, get: (id) => BY[id] || null };
})();
