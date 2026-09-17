-- =====================================================================
-- bk_002_capture  |  독서 기록 앱(book-log) 3단계: 문장 찍기 · 밑줄 준비
-- 대상  : Supabase 프로젝트 live-poll (jnsfnwmtrozgiqntrymg)
-- 작성  : 2026-09-17 · PRD v1.0 기준
-- 상태  : 실행함 (2026-09-17 사용자 승인 → 마이그레이션 bk_002_capture, 결과 확인 끝)
-- 참고  : 끝에 「-- @storage」 표시가 붙은 줄은 시험 환경(setup.sh)이 건너뜀 (작업 컴퓨터엔 storage 가 없음)
--
-- 이 파일이 하는 일
--   1) bk_notes 표에 칸 하나(thought, 「내 생각 한마디」)를 더한다.
--   2) 사진 창고 bk-photos 를 새로 만든다.
--        · 비공개(public = false) — 주소를 알아도 열리지 않음
--        · 한 장 2MB 까지, 사진 형식(jpeg · png · webp)만
--        · 창고 규칙(policy)은 만들지 않음 → 화면용 키로는 못 열고,
--          bk-api 엣지함수(service_role)만 넣고 · 꺼내고 · 지운다.
--          (확인: 지금 storage 에 걸린 규칙 0개라 다른 규칙이 이 창고를 열어 주지 않음)
--
-- 이 파일이 하지 않는 일
--   · bk_ 가 아닌 표 · 함수 · cron, 기존 창고(review-images, tg-archive)는 건드리지 않는다.
--   · 지우기(DROP · DELETE) 명령이 없다. 로그인 설정 · 확장 기능 · 요금 설정을 건드리지 않는다.
--
-- begin ~ commit 으로 묶여 있어, 중간에 하나라도 실패하면 아무것도 남지 않는다.
-- =====================================================================

begin;

-- 1) 찍은 문장에 붙이는 「내 생각 한마디」 (선택, 2000자까지) -----------------
alter table public.bk_notes
  add column thought text,
  add constraint bk_notes_thought_length check (thought is null or char_length(thought) <= 2000);

-- 2) 사진 창고 (비공개) --------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)  -- @storage
values ('bk-photos', 'bk-photos', false, 2097152, array['image/jpeg', 'image/png', 'image/webp']);  -- @storage

commit;
-- 끝. (bk_ · bk- 가 아닌 것은 하나도 만들거나 고치지 않음)
