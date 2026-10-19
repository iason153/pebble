'use strict';

/**
 * Billbox 폰 안 저장소(IndexedDB) — 화면(app)과 서비스워커(알림) 둘 다 쓴다.
 *
 * - photos : 고지서 사진(긴 변 1400px JPEG). 키 = 항목 id. 폰 밖으로 절대 안 나감. 백업 파일에도 안 들어감.
 *            { blob, due(그 사진의 마감), savedAt, paidAt(냈어요 누른 때 → 보관 기간 계산) }
 * - mirror : 알림 문구용 항목 사본(이름·금액·예상 여부). 서비스워커는 localStorage를 못 읽어서 여기 둔다.
 *            서버는 "이 항목 알릴 때"라는 신호만 보내고, 금액은 폰이 여기서 꺼내 문구를 만든다.
 * - inbox  : 카톡·갤러리 "공유"로 받은 사진을 잠깐 두는 곳(앱이 열리면 바로 꺼내고 지움).
 */
(function (root) {
  const NAME = 'billbox';
  const VER = 2; // v2: stack(정리함) 추가
  let dbp = null;

  function open() {
    if (dbp) return dbp;
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open(NAME, VER);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('photos')) db.createObjectStore('photos');
        if (!db.objectStoreNames.contains('mirror')) db.createObjectStore('mirror');
        if (!db.objectStoreNames.contains('inbox')) db.createObjectStore('inbox');
        if (!db.objectStoreNames.contains('stack')) db.createObjectStore('stack'); // 정리함: 찍은 고지서가 확인 전까지 있는 곳
      };
      req.onsuccess = () => {
        const db = req.result;
        // 다른 탭이 새 버전으로 올리려 하면 이 연결을 놓아줌(업그레이드가 영영 막히는 일 방지)
        db.onversionchange = () => {
          try {
            db.close();
          } catch (_) {}
          dbp = null;
        };
        resolve(db);
      };
      req.onblocked = () => {
        // 옛 탭이 붙들고 있음 → 8초 기다리다 안 되면 실패 처리(앱은 안내를 띄움)
        setTimeout(() => {
          dbp = null;
          reject(new Error('blocked'));
        }, 8000);
      };
      req.onerror = () => {
        dbp = null;
        reject(req.error);
      };
    });
    return dbp;
  }

  async function tx(store, mode, fn) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const t = db.transaction(store, mode);
      const s = t.objectStore(store);
      let out;
      Promise.resolve(fn(s)).then((v) => (out = v));
      t.oncomplete = () => resolve(out);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  }
  const req2p = (r) => new Promise((res, rej) => ((r.onsuccess = () => res(r.result)), (r.onerror = () => rej(r.error))));

  const api = {
    // ---- 사진 ----
    putPhoto: (id, rec) => tx('photos', 'readwrite', (s) => s.put(rec, id)).catch(() => {}),
    getPhoto: (id) => tx('photos', 'readonly', (s) => req2p(s.get(id))).catch(() => null),
    delPhoto: (id) => tx('photos', 'readwrite', (s) => s.delete(id)).catch(() => {}),
    async patchPhoto(id, patch) {
      const rec = await api.getPhoto(id);
      if (rec) await api.putPhoto(id, Object.assign(rec, patch));
    },
    async allPhotos() {
      try {
        return await tx('photos', 'readonly', (s) => Promise.all([req2p(s.getAllKeys()), req2p(s.getAll())]).then(([k, v]) => k.map((key, i) => [key, v[i]])));
      } catch (_) {
        return [];
      }
    },
    clearPhotos: () => tx('photos', 'readwrite', (s) => s.clear()).catch(() => {}),

    // ---- 알림용 사본 ----
    putMirror: (items) => tx('mirror', 'readwrite', (s) => s.put(items, 'items')).catch(() => {}),
    getMirror: () => tx('mirror', 'readonly', (s) => req2p(s.get('items'))).catch(() => null),

    // ---- 정리함(stack): 찍기 = 여기 넣기. 종이는 버려도 됨. 읽기·확인은 나중에 ----
    // rec = { blob, addedAt, status:'new'|'read'|'fail', ex(읽은 결과), from, source:'ai'|'local' }
    stackAdd(blob, from) {
      const id = 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
      return tx('stack', 'readwrite', (s) => s.put({ blob, addedAt: Date.now(), status: 'new', ex: null, from: from || '' }, id)).then(() => id).catch(() => null);
    },
    stackGet: (id) => tx('stack', 'readonly', (s) => req2p(s.get(id))).catch(() => null),
    async stackAll() {
      try {
        const rows = await tx('stack', 'readonly', (s) => Promise.all([req2p(s.getAllKeys()), req2p(s.getAll())]).then(([k, v]) => k.map((key, i) => [key, v[i]])));
        return rows.sort((a, b) => (a[1].addedAt || 0) - (b[1].addedAt || 0));
      } catch (_) {
        return [];
      }
    },
    async stackPatch(id, patch) {
      const rec = await api.stackGet(id);
      if (rec) await tx('stack', 'readwrite', (s) => s.put(Object.assign(rec, patch), id)).catch(() => {});
    },
    stackDel: (id) => tx('stack', 'readwrite', (s) => s.delete(id)).catch(() => {}),

    // ---- 공유로 받은 사진 ----
    putInbox: (blob) => tx('inbox', 'readwrite', (s) => s.put({ blob, at: Date.now() }, 'shared')),
    async takeInbox() {
      try {
        const rec = await tx('inbox', 'readonly', (s) => req2p(s.get('shared')));
        await tx('inbox', 'readwrite', (s) => s.delete('shared'));
        return rec && rec.blob ? rec.blob : null;
      } catch (_) {
        return null;
      }
    },
  };

  root.BillboxDB = api;
})(typeof self !== 'undefined' ? self : window);
