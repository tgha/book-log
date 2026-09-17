# 연습용 시험 환경 (Claude 작업 컴퓨터용)

실제 Supabase 와 똑같은 조건을 작업 컴퓨터 안에 만들어 시험하는 도구입니다. 작업 컴퓨터는 대화마다 비워질 수 있어 매번 다시 준비합니다.
(작업 컴퓨터에서는 supabase.co 로 직접 요청이 막혀 있음 — host_not_allowed)

## 설치 (Ubuntu)
1. `apt-get install -y postgresql` (16) → `/usr/lib/postgresql/16/bin`
2. Deno 2.5.4: github releases `deno-x86_64-unknown-linux-gnu.zip` → `/usr/local/bin`
   - npm 받기 오류 시 `DENO_TLS_CA_STORE=system`
3. PostgREST v12.2.12: `postgrest-v12.2.12-linux-static-x86-64.tar.xz`
4. Playwright(파이썬) · 크롬 · Pillow 는 이미 있음 (`PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers`)

## 준비 (한 번)
- 저장소를 `/home/claude/book-log` 에 두고 `sh docs/test-kit/setup.sh`
  - DB 만들기(포트 55432, 소켓 /tmp/pgtest) · 역할(anon · authenticated · service_role · authenticator)
  - **Supabase 흉내**: 새 표에 anon 권한이 자동으로 붙게 함 (실제 프로젝트와 같음)
  - `supabase/bk_0*.sql` 을 차례로 실행 (`-- @storage` 줄은 건너뜀), `/tmp/keys.env` 열쇠(시험용 JWT) 만들기
  - 시험 도구를 `/tmp/bktest` 로 복사

## 실행
- `/tmp/bktest/up.sh`: 꺼진 것만 다시 켬 (DB → PostgREST → 게이트웨이·함수 5개 → 웹 8080)
- `start.sh`: 게이트웨이(8000) + 함수 5개(bk-auth 9001 · bk-admin 9002 · bk-book 9003 · bk-api 9004 · bk-ocr 9005)
- `gateway.ts` 가 흉내 내는 것
  - `/rest/v1` → PostgREST, `/functions/v1/bk-*` → 각 함수
  - 가짜 카카오 `/v3/search/book` (열쇠 `test-key`)
  - 가짜 구글 Vision `/v1/images:annotate` (머리글 열쇠 `test-vision-key`). 동작 바꾸기: `GET /__vision?mode=ok|empty|err500|badkey|denied|quota|badimage|slow|text&text=...` (호출 수 · 마지막 요청도 알려 줌)
  - 가짜 사진 창고 bk-photos (올리기 · 서명 주소 · 보기 · 지우기). 목록 `GET /__photos`, 비우기 `?clear=1`
- `wrap.ts`: 함수 코드를 고치지 않고 포트만 바꿔 실행
- `static.mjs`: 8080 웹 서버, vercel.json 보안 헤더 그대로(사진 보기용 img-src 에 로컬 주소만 더함), config.js 서버 주소만 로컬로
- ⚠️ `pkill -f "<명령어>"` 는 자기 자신(bash)까지 죽이므로 쓰지 말 것

## 시험 (2026-09-17 3단계 기준 전부 통과)
| 스크립트 | 내용 | 개수 |
| --- | --- | --- |
| `api_test.py` | 1단계 서버 (가입 · 로그인 · 관리자) | 45 |
| `api2_test.py` | 2단계 서버 (책 검색 · 서재) | 32 |
| `api3_test.py` | 3단계 서버 (글자 읽기 · 하루 한도 · 동시 누르기 · 메모 · 밑줄 · 사진 · 사용량) | 76 |
| `ui_test.py` | 1단계 화면 | 28 |
| `ui2_test.py` | 2단계 화면 | 29 |
| `scan_test.py` | 가짜 카메라 · 가짜 바코드 | 7 |
| `ui3_test.py` | 3단계 화면 (비스듬한 가짜 페이지 사진 → 귀퉁이 끌기 → 펴기 결과를 픽셀로 확인 → 자르기 · 돌리기 → 글자 읽기 실패/다시 시도 → 고치기 · 밑줄 → 저장 → 메모 · 기록 탭 · 관리자 · PC) | 75 |

- 실행 전 `export PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers NO_PROXY=127.0.0.1,localhost`
- 브라우저 콘솔의 401/403/429 와 fonts.googleapis.com 오류는 정상(의도된 시험 · 글꼴 서버 차단)
- 알아 둘 점: 시험용 크롬은 **[뒤로 가기] 뒤 터치 화면 흉내가 풀려** `(pointer: coarse)` 가 false 가 됨 → 사진 고르기 화면이 PC 모양으로 나올 수 있음 (실제 폰과 무관, ui3 는 두 모양 다 처리)
