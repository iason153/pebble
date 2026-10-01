'use strict';

/**
 * 카카오 장소 검색 / 현재 위치 주소 — 카카오맵 JavaScript SDK(services 라이브러리)
 *
 * - SDK는 처음 검색할 때 한 번만 불러온다(첫 화면을 가볍게).
 * - JavaScript 키는 pebbleitgo.com 주소로 잠겨 있어서 다른 주소에선 실패한다.
 *   실패하면 "검색을 불러오지 못했어요"로 안내하고 다시 시도할 수 있게 한다.
 * - 결과는 앱에서 쓰기 쉬운 모양 {id,name,address,lat,lng,categoryCode,categoryName,distance}
 *   으로 바꿔서 돌려준다. 이 정보는 기기 안에만 저장되고 통계로는 보내지 않는다.
 */
window.GetsetPlaces = (function () {
  const KEY = (window.GETSET_CONFIG || {}).KAKAO_JS_KEY || '';
  let loading = null;

  function load() {
    if (window.kakao && window.kakao.maps && window.kakao.maps.services) return Promise.resolve();
    if (loading) return loading;
    loading = new Promise((resolve, reject) => {
      if (!KEY) return reject(new Error('no-key'));
      const s = document.createElement('script');
      s.src = `https://dapi.kakao.com/v2/maps/sdk.js?appkey=${encodeURIComponent(KEY)}&libraries=services&autoload=false`;
      s.async = true;
      const timer = setTimeout(() => reject(new Error('timeout')), 12000);
      s.onload = () => {
        try {
          window.kakao.maps.load(() => {
            clearTimeout(timer);
            resolve();
          });
        } catch (e) {
          clearTimeout(timer);
          reject(e);
        }
      };
      s.onerror = () => {
        clearTimeout(timer);
        reject(new Error('load-failed'));
      };
      document.head.appendChild(s);
    }).catch((e) => {
      loading = null; // 다음에 다시 시도할 수 있게
      throw e;
    });
    return loading;
  }

  function toPlace(d) {
    return {
      id: String(d.id),
      name: d.place_name,
      address: d.road_address_name || d.address_name || '',
      lat: Number(d.y),
      lng: Number(d.x),
      categoryCode: d.category_group_code || '',
      categoryName: d.category_name || '',
      distance: d.distance ? Number(d.distance) : null,
    };
  }

  /**
   * @param {string} query
   * @param {{lat:number,lng:number}|null} near  가까운 곳 우선 + 거리 표시용
   * @returns {Promise<Array>}
   */
  async function search(query, near) {
    await load();
    const k = window.kakao.maps;
    const ps = new k.services.Places();
    const opts = { size: 15 };
    if (near && Number.isFinite(near.lat)) {
      opts.location = new k.LatLng(near.lat, near.lng);
    }
    return new Promise((resolve, reject) => {
      ps.keywordSearch(
        query,
        (data, status) => {
          const S = k.services.Status;
          if (status === S.OK) resolve(data.map(toPlace));
          else if (status === S.ZERO_RESULT) resolve([]);
          else reject(new Error('search-error'));
        },
        opts
      );
    });
  }

  /** 좌표 → "산본동" 같은 짧은 동네 이름 + 주소 */
  async function reverse(lat, lng) {
    await load();
    const k = window.kakao.maps;
    const geocoder = new k.services.Geocoder();
    return new Promise((resolve) => {
      geocoder.coord2Address(lng, lat, (res, status) => {
        if (status !== k.services.Status.OK || !res || !res[0]) return resolve({ area: '', address: '' });
        const a = res[0].road_address || res[0].address || {};
        const area = (res[0].address && (res[0].address.region_3depth_name || res[0].address.region_2depth_name)) || '';
        resolve({ area, address: a.address_name || '' });
      });
    });
  }

  /** 현재 위치 → place 모양. 권한 거부·실패 시 reject(code) */
  function current() {
    return new Promise((resolve, reject) => {
      if (!navigator.geolocation) return reject(new Error('unsupported'));
      navigator.geolocation.getCurrentPosition(
        async (pos) => {
          const lat = pos.coords.latitude;
          const lng = pos.coords.longitude;
          let info = { area: '', address: '' };
          try {
            info = await reverse(lat, lng);
          } catch (_) {}
          resolve({
            id: 'current',
            name: info.area ? `현재 위치 (${info.area})` : '현재 위치',
            address: info.address,
            lat,
            lng,
            categoryCode: '',
            categoryName: '',
            distance: null,
          });
        },
        (err) => reject(new Error(err && err.code === 1 ? 'denied' : 'failed')),
        { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 }
      );
    });
  }

  return { load, search, reverse, current };
})();
