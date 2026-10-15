# Tapit 설계문서 v1.0 (2026-10-14)

> Pebble 세 번째 툴. 자주 보내는 링크를 모아 두고 탭 한 번으로 복사하는 링크 메모장.
> 주소: https://pebbleitgo.com/tapit/ · 저장소: iason153/pebble 의 `tapit/` 폴더 · 2026-10-14 공개(검색 허용, Pebble 메인 등록)

---

## 1. 왜 만들었나

- 대표가 여러 프로젝트 링크를 뿌리며 메모장으로 관리 → ① 채널별 UTM 꼬리표를 매번 손으로 만들기 귀찮음 ② 메모장에서 찾아 꾹 눌러 범위 잡아 복사하기 귀찮음 ③ 얼마나 뿌렸는지 모름.
- 기존 툴 조사: 북마크 보관함(Raindrop, 국내 링크포켓·포킷 등)은 "남의 링크 저장", 짧은 링크·UTM 툴(Bitly, UTM.io)은 유료·무거움·영어, 홍보 기록장(OutreachLog 등)은 해외 채널 기준. **"내가 뿌리는 링크 장부"를 한국 채널 기준으로 메모장처럼 가볍게** 쓰는 툴은 없음.
- 목표: 뿌리는 사람(사업자)과 그냥 저장하는 사람 모두에게 쉬울 것. 초등학생도 설명 없이 쓸 수 있을 것.

## 2. 대표가 정한 원칙

- 디자인: 메모장 스타일, 심플하고 고급스럽게. 굵은 선·두꺼운 테두리(네오 브루탈리즘) 거부. 억지 한글화 금지 — 흔히 쓰는 웹·앱 용어 사용(추가/편집/삭제/카테고리/채널/공유).
- 모바일 최우선, PC도 지원(사업자는 PC에서 블로그·상세페이지 작업).
- 화면에 UTM·소스·캠페인 같은 전문 용어를 꺼내지 않는다. 필요한 사람만 "고급 설정"에서.
- 상단에 사용법·공유·앱 설치. 목표는 폰 홈 화면 설치.

## 3. 화면과 기능 (v1 공개본)

- **상단**: 로고 · 사용법 · 공유(점 세 개 공유 아이콘 + "공유" 글자) · 앱 설치
- **추가**: 입력란에 링크 붙여넣기 → [추가] → "링크 추가" 창(이름, 카테고리 드롭다운 + 새 카테고리, 고급 설정) → 저장
- **카드**: 카테고리·이름·주소 / 오른쪽 위 아이콘(열기·편집·삭제, 삭제는 실행 취소 가능) / 버튼 두 개
  - **복사**: 원본 링크 복사
  - **채널 공유**: 채널을 고르면 UTM 붙은 링크 복사 + 횟수 기록(실행 취소 가능). 자주 쓴 채널 순으로 한 줄만, 나머지는 `+N`
- **카테고리 줄**: 한 줄 넘으면 `+N`으로 접힘
- **채널 관리**: 기본 17개(네이버 카페·밴드·카카오톡·인스타그램·당근·유튜브·네이버 블로그·페이스북·스레드·X·틱톡·오픈채팅·텔레그램·디스코드·문자·이메일·QR·인쇄물) 켜고 끄기 + 직접 추가(이름, 영문 표기, 고급: 유형)
- **사용법**: 그림 4단계(추가 → 이름 → 복사 → 채널 공유). 3단계까지만 알아도 충분하도록 구성. 자주 묻는 질문 접기.
- **GA 연동 유도**: 공유 3회 이상이면 상단 안내 / 카드의 "방문 수 보기" → 연동 후 화면 예시 시트(버튼은 "준비 중")
- **다른 앱에서 넣기**: manifest `share_target` — 설치 후 안드로이드 공유 메뉴에서 Tapit 선택 시 추가 창
- **저장**: 기기 안(localStorage `tapit:v1`). 서버 없음.

## 4. UTM 생성 규칙

- `utm_source` = 채널 영문(cafe, kakaotalk …) / `utm_medium` = 채널 유형(community, social, messenger, blog, print, sms, email, referral)
- `utm_campaign` = `[캠페인 이름]_[유형]_[MMDD]` — 캠페인 이름 비우면 링크 주소 마지막 경로에서 자동(예: hello_swing_1013). 유형(출시·업데이트·이벤트·공지·결과)은 고급 설정에서만.
- 프로젝트 문서 `claude/UTM_이름_규칙.md`와 값 일치. 새로 쓴 medium 값 `blog`·`sms`·`email`·`referral`은 규칙 문서 표에 추가 필요.
- 앱 자체 공유: `utm_source=share&utm_medium=referral&utm_campaign=app_share&utm_content=kakao|native|copy`. 앱 아이콘 실행: `utm_source=pwa&utm_medium=app_icon`.

## 5. 공유·설치 (Getset install.js·share.js 흐름 이식)

- **설치**: 크롬 = 버튼 한 번(beforeinstallprompt) / 아이폰 = 3단계 안내 / 삼성 인터넷 = 메뉴 안내 / 카톡·네이버·밴드·인스타 등 인앱 = 상단 안내 + 크롬으로 열기(카톡 `kakaotalk://web/openExternal`, 안드로이드 `intent://`) → `?pwa=install`로 열려 설치 안내 자동 표시
- **공유**: 카카오톡(Kakao SDK 2.7.2, feed 카드: og.png + 제목·설명 + "Tapit 열기" 버튼) / 다른 앱(navigator.share) / 링크 복사
- **카카오 설정(2026-10-14)**: Pebble 카카오 앱(JS 키 a80d2ef4…, 공개 키)에 "제품 링크 관리 → 웹 도메인" pebbleitgo.com 등록해야 카드 클릭이 됨(등록 전엔 메시지만 가고 클릭 불가). 공유 그림은 카카오가 캐시하므로 그림을 바꾸면 `og.png?v=숫자`를 올릴 것(현재 v=3). 캐시 초기화는 카카오 공유 디버거.
- **통계**: GA4 Pebble 속성(G-4Q8F4E2J61), 모든 이벤트에 `tool=tapit`. 링크 주소·이름은 보내지 않음. 이벤트: link_add, link_copy, channel_copy(channel), guide_open, share_sheet_open, app_share(method), install_sheet_open, install_click, app_installed, inapp_detected, inapp_open_click, ga_sheet_open(from), ga_connect_click, share_target_in

## 6. 파일

```
tapit/
  index.html          화면·스타일·스크립트 한 파일
  manifest.json       PWA + share_target
  service-worker.js   tapit-shell-v3 (HTML 등 네트워크 먼저)
  og.png              공유 카드 그림 1200×630
  icons/              icon-192/512, maskable-192/512, apple-touch-icon, favicon-32 (임시: 검은 바탕 흰 T + 노란 점)
```
Pebble 메인(`/index.html`)에 Tapit 카드 추가, `/sitemap.xml`에 `/tapit/` 추가, `/icons/`에 새 Pebble 로고(렌치 든 조약돌 캐릭터).

## 7. Pebble 로고 (2026-10-14 확정)

- 렌치를 든 웃는 조약돌 캐릭터. ChatGPT 4안(p 글자 / 캐릭터 / 공구함 / 전구) 중 이름(조약돌)과 하는 일(고쳐 줌)을 함께 담은 캐릭터안 선택.
- 색: #17181C · #FFD43B · #F6F5F3. 파일: pebble-logo-1024, kakao-app-icon-512, icon-512/192, maskable-512/192, apple-touch-icon, favicon-48/32.
- 카카오 디벨로퍼스 Pebble 앱 아이콘을 이 로고로 교체해야 공유 카드 아래 Getset 로고가 바뀜.

## 8. 남은 일 (다음 단계)

1. **사용법 페이지** `tapit/guide.html` — 검색용 글 페이지("링크 메모장", "링크 저장 앱", "카톡 나에게 보내기 대신", "UTM 링크 만들기")
2. **사이트 간 연결** — 헬로대부도·대부도타임·오락실 하단에 Pebble 도구 링크(UTM source=daebutalk 등)
3. **Google Analytics 연동** — 서버 없이 브라우저에서 OAuth(읽기 전용) + GA Data API·Admin API 직접 호출. 대표 준비: Pebble 구글 클라우드에서 두 API 켜기, OAuth 동의 화면, 웹 클라이언트 ID(허용 주소 https://pebbleitgo.com) → 클라이언트 ID 전달. 개인정보처리방침 페이지 필요. 처음엔 테스트 모드(최대 100명), 공개는 구글 심사 후. 숫자는 하루 늦게 반영.
4. **의견 보내기 버튼**(오픈채팅 또는 구글 폼 — 대표 선택 대기)
5. **백업** — 내보내기/가져오기(기기 안 저장이라 브라우저 기록 삭제·폰 교체 시 사라짐)
6. **폰·PC 연결** — 연결 코드(QR) + 구글 로그인 둘 다. 작은 저장 서버 필요(비용 발생 기능은 수익화 이후 원칙 확인)
7. Tapit 정식 아이콘(현재 임시), Pebble 메인 공유 그림(현재 Lineup 그림)
8. 검색 등록: 구글 서치콘솔·네이버 서치어드바이저 사이트맵 재제출, 빙 웹마스터·다음 등록 (대표)
9. 오토컴퍼니 프로젝트 방 등록 (Lineup·Getset과 함께)
10. **GA4 주요 이벤트 표시 (다음 접속 때 먼저 안내할 것)** — 2026-10-14 대표가 폰에서 `channel_copy`·`app_installed`를 한 번씩 발생시킴. 관리 → 데이터 표시 → 이벤트 목록에 두 이벤트가 올라왔는지 확인 후 별(★)로 주요 이벤트 표시. "이벤트 만들기" 화면은 쓰지 말 것(page_view 기반 가짜 이벤트가 생김). 맞춤 측정기준 `tool`(이벤트 범위) 등록 여부도 확인. 서치콘솔 ↔ GA4 연결은 2026-10-14 완료 → 보고서 라이브러리에서 Search Console 컬렉션 게시 여부 확인.
11. 네오 브루탈리즘 검토 결과: 전체 적용은 안 함. 원하면 복사·채널 버튼에만 짧은 그림자 한 방울 넣은 비교안.

## 8-1. v4·v5 반영 (2026-10-15)

- **v4**: 백업(화면 맨 아래, 내보내기 = `tapit-backup-YYYYMMDD.json` 저장 / 가져오기 = 주소 기준 중복 건너뛰고 합침 / 링크 5개 이상인데 백업 없으면 빨간 안내), 의견 보내기(오락실 문의 오픈채팅 https://open.kakao.com/o/s6jWLxuh — Pebble 전용 채팅 생기면 교체), 사용법 페이지 `tapit/guide.html`(검색어: 링크 메모장·카톡 나에게 보내기 대신·UTM 링크 만들기, FAQ 6개, WebApplication·FAQPage 구조화 정보), 메인 제목 "Tapit 탭잇 — 무료 링크 메모장, 탭 한 번으로 링크 복사", 하단 소개글, sitemap에 guide 추가.
- **Tapit 정식 아이콘**: ChatGPT 4안 중 1번(노란 메모지 + 검은 링크 + 노란 탭 표시). 2번(흰 메모지)은 32px에서 배경에 묻혀 제외. 파일 `tapit/icons/`(tapit-logo-1024 포함).
- **v5 Google Analytics 연동 (구현 완료, 테스트 모드)**
  - 구글 클라우드 프로젝트 `pebble-lineup`(iason153@gmail.com): Analytics Data API·Admin API 사용, OAuth 앱 이름 Tapit(외부, 테스트 중), 승인된 도메인 pebbleitgo.com, 범위 `analytics.readonly`, 테스트 사용자 iason153·creatorock153, 웹 클라이언트 "Tapit web"(JS 원본 https://pebbleitgo.com, https://www.pebbleitgo.com).
  - 클라이언트 ID(공개값): `973607682974-i24c50abhlbkpri3ud779ul415ql3b3a.apps.googleusercontent.com`. 보안 비밀번호는 쓰지 않음.
  - 동작: Google Identity Services 토큰 방식(팝업) → Admin API로 계정의 속성 목록(최대 25개) → 속성마다 Data API 2회(hostName 목록 / hostName·sessionSource·sessionCampaignName별 세션, 최근 90일) → 링크 주소의 도메인 + 캠페인 앞부분(`캠페인이름_`)이 맞는 행을 채널(utm_source)별로 합산. 결과는 기기에만 저장(`S.ga`), 토큰은 메모리만.
  - 화면: 카드 메타에 "방문 N", "자세히" → 링크별 채널 표(공유·방문·합계), 연동 해제·새로고침. 카톡 등 인앱에서는 구글이 로그인을 막으므로 크롬으로 열라고 안내. 시범 운영 문구 표시.
  - 개인정보처리방침 `tapit/privacy.html`(Google API 사용자 데이터 정책·제한적 사용 문구 포함).
  - 남은 일: 실제 계정으로 첫 연동 시험(대표), 정식 공개 시 구글 앱 심사(로고 120×120 업로드, 시연 영상 등).

## 8-2. 남은 일 정리 (2026-10-15 기준, 이 목록이 최신)

완료: v6 배포본 전달(상단 로고를 새 아이콘으로, 글자 옆 노란 박스 제거). GA4 주요 이벤트(app_installed·channel_copy) 표시, 서치콘솔↔GA4 연결, Search Console 보고서 게시 완료. 대표 계정으로 GA 연동 실사용 확인(방문 1 표시).

대표 할 일
1. v6 업로드(tapit 폴더) — v5까지 올렸다면 tapit 폴더만 덮어쓰기
2. 서치콘솔·네이버에서 `/tapit/guide.html` 색인 요청
3. 카카오 디벨로퍼스 Pebble 앱 아이콘을 Pebble 로고로 교체(완료 여부 미확인)
4. 맞춤 측정기준 `tool` 등록 여부 확인
5. 홍보(스레드·대부도 주민 카페), 1~2주 사용 후 피드백
6. 오토컴퍼니 프로젝트 방 등록(Lineup·Getset과 함께)

다음 개선 후보(피드백 보고 우선순위 결정)
- 링크 주소 수정, 검색칸, 자주 쓰는 링크 고정·순서 바꾸기
- 폰·PC 연결(저장 서버 필요 — 비용 원칙상 요청이 나오면)
- GA 연동 정식 공개(구글 앱 심사)
- Pebble 전용 오픈채팅 생기면 의견 보내기 주소 교체
- 사이트 간 연결(헬로대부도·대부도타임·오락실 하단에 Pebble 도구 링크)
- Pebble 메인 공유 그림(현재 Lineup 그림)

## 9. 작업 방식

- 샌드박스에서 개발 → zip 전달 + 업로드 주소(https://github.com/iason153/pebble/upload/main) → 대표가 GitHub 웹으로 업로드 → Vercel 자동 배포.
- Claude가 저장소에 직접 올리려면 Claude GitHub 앱 설치 또는 claude.ai 설정에서 GitHub 재연결 필요(2026-10-13 기준 쓰기 거절됨).
- 미리보기 아티팩트가 대표 화면에 뜨지 않는 경우가 있어, 실제 확인은 Vercel 배포 후 폰에서 하는 쪽으로 진행.

## 10. 새 세션 시작 문구

```
Pebble의 Tapit(탭잇, 링크 메모장) 작업을 이어서 한다.
프로젝트 문서 docs/Tapit_설계문서_v1.0.md 를 먼저 끝까지 읽어라.

- 주소 https://pebbleitgo.com/tapit/ , 코드는 GitHub iason153/pebble 의 tapit/ 폴더(먼저 최신을 받아 볼 것).
- 파일은 zip으로 주고 업로드 주소(https://github.com/iason153/pebble/upload/main)도 같이 준다.
- 화면에 전문 용어(UTM·소스·캠페인)를 꺼내지 않는다. 디자인은 메모장 스타일, 심플·고급.
- 문서 8장 "남은 일"에서 시작하되, 먼저 나에게 무엇부터 할지 물어라.
```
