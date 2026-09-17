-- =====================================================================
-- bk_001_init  |  독서 기록 앱(book-log) 1단계: 표 만들기
-- 대상  : Supabase 프로젝트 live-poll (jnsfnwmtrozgiqntrymg)
-- 작성  : 2026-09-17 · PRD v1.0 기준
-- 상태  : 승인 대기 (아직 실행 안 함)
--
-- 이 파일이 하는 일
--   1) bk_ 로 시작하는 표 9개를 새로 만든다.
--   2) 9개 표 모두 잠금(RLS)을 켜고, 화면용 키(anon·authenticated) 권한을 회수한다.
--      (이 프로젝트는 새 표에 anon 권한을 자동으로 주도록 설정되어 있어 명시적으로 막는다)
--      → 폰·PC 화면은 표에 직접 접근 못 하고, bk- 엣지함수(service_role)만 읽고 쓴다.
--   3) 설정값 1개(글자 읽기 하루 한도 = 100)를 넣는다.
--
-- 이 파일이 하지 않는 일
--   · bk_ 가 아닌 표·함수·cron·사진 창고·엣지함수는 읽지도, 고치지도, 지우지도 않는다.
--   · 로그인 설정(auth), 확장 기능, 요금 설정을 건드리지 않는다.
--   · DROP(지우기) 명령이 없다.
--
-- begin ~ commit 으로 묶여 있어, 중간에 하나라도 실패하면 아무것도 남지 않는다.
-- =====================================================================

begin;

-- 1) 회원 ------------------------------------------------------------
create table public.bk_users (
  id               uuid primary key default gen_random_uuid(),
  username         text not null,                       -- 아이디 (영문 소문자·숫자·_ 3~20자)
  password_hash    text not null,                       -- 암호화된 비밀번호 (원래 비밀번호는 저장 안 함)
  display_name     text not null,                       -- 보이는 이름
  status           text not null default 'pending',     -- pending 대기 · approved 승인 · rejected 거절 · disabled 중지
  is_admin         boolean not null default false,
  failed_attempts  int not null default 0,              -- 비밀번호 틀린 횟수
  locked_until     timestamptz,                         -- 5번 틀리면 15분 잠금
  keep_photo       boolean not null default false,      -- [사진도 남기기] 마지막 선택
  created_at       timestamptz not null default now(),
  approved_at      timestamptz,
  approved_by      uuid references public.bk_users(id) on delete set null,
  constraint bk_users_status_check        check (status in ('pending','approved','rejected','disabled')),
  constraint bk_users_username_format     check (username ~ '^[a-z0-9_]{3,20}$'),
  constraint bk_users_display_name_length check (char_length(display_name) between 1 and 20)
);
create unique index bk_users_username_key on public.bk_users (username);


-- 2) 로그인 유지 (폰마다 받는 출입증) -------------------------------------
create table public.bk_sessions (
  token_hash    text primary key,                       -- 출입증을 한 번 더 암호화한 값
  user_id       uuid not null references public.bk_users(id) on delete cascade,
  created_at    timestamptz not null default now(),
  expires_at    timestamptz not null,                   -- 30일 뒤
  last_used_at  timestamptz not null default now(),
  user_agent    text                                    -- 어느 기기인지 (예: 안드로이드 크롬)
);
create index bk_sessions_user_idx on public.bk_sessions (user_id);


-- 3) 책 정보 (모두가 나눠 씀) -------------------------------------------
create table public.bk_books (
  id            uuid primary key default gen_random_uuid(),
  isbn13        text,                                   -- 13자리, 직접 입력한 책은 비어 있을 수 있음
  title         text not null,
  authors       text[] not null default '{}',
  translators   text[] not null default '{}',
  publisher     text,
  published_on  date,
  cover_url     text,
  description   text,
  source        text not null default 'kakao',          -- kakao 검색 · manual 직접 입력
  created_by    uuid references public.bk_users(id) on delete set null,
  created_at    timestamptz not null default now(),
  constraint bk_books_source_check  check (source in ('kakao','manual')),
  constraint bk_books_isbn13_format check (isbn13 is null or isbn13 ~ '^[0-9]{13}$')
);
create unique index bk_books_isbn13_key on public.bk_books (isbn13) where isbn13 is not null;


-- 4) 내 서재 (누가 어떤 책을) ---------------------------------------------
create table public.bk_shelf (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references public.bk_users(id) on delete cascade,
  book_id       uuid not null references public.bk_books(id) on delete restrict,
  status        text not null default 'reading',        -- want 읽고 싶은 · reading 읽는 중 · finished 다 읽음 · stopped 그만 읽음
  started_on    date,
  finished_on   date,
  total_pages   int,
  current_page  int,
  is_public     boolean not null default false,         -- 책 단위 공개 (켜면 기록 전체 공개)
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint bk_shelf_status_check   check (status in ('want','reading','finished','stopped')),
  constraint bk_shelf_pages_check    check (total_pages is null or total_pages between 1 and 20000),
  constraint bk_shelf_current_check  check (current_page is null or current_page >= 0),
  constraint bk_shelf_user_book_key  unique (user_id, book_id)
);
create index bk_shelf_public_idx on public.bk_shelf (user_id) where is_public;


-- 5) 독서 시간 --------------------------------------------------------
create table public.bk_reading_logs (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.bk_users(id) on delete cascade,
  shelf_id    uuid not null references public.bk_shelf(id) on delete cascade,
  method      text not null,                            -- timer 타이머 · manual 손으로 적기
  started_at  timestamptz,                              -- 타이머 시작 시각
  ended_at    timestamptz,                              -- 비어 있으면 "타이머가 돌고 있는 중"
  minutes     int,
  read_on     date not null,                            -- 한국 시간 기준 날짜 (자정 넘기면 시작한 날)
  end_page    int,
  created_at  timestamptz not null default now(),
  constraint bk_reading_logs_method_check  check (method in ('timer','manual')),
  constraint bk_reading_logs_minutes_check check (minutes is null or minutes between 0 and 1440),
  constraint bk_reading_logs_page_check    check (end_page is null or end_page >= 0),
  constraint bk_reading_logs_shape_check   check (
       (method = 'timer'  and started_at is not null and (ended_at is null or ended_at >= started_at))
    or (method = 'manual' and minutes is not null)
  )
);
-- 한 사람은 타이머를 하나만 돌릴 수 있음
create unique index bk_reading_logs_one_running_timer
  on public.bk_reading_logs (user_id) where method = 'timer' and ended_at is null;
create index bk_reading_logs_user_day_idx on public.bk_reading_logs (user_id, read_on);
create index bk_reading_logs_shelf_idx    on public.bk_reading_logs (shelf_id);


-- 6) 메모 -----------------------------------------------------------
create table public.bk_notes (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.bk_users(id) on delete cascade,
  shelf_id    uuid not null references public.bk_shelf(id) on delete cascade,
  kind        text not null,                            -- capture 찍은 문장 · thought 내 생각
  body        text not null,
  page        int,
  photo_path  text,                                     -- 사진을 남겼을 때만 (사진 창고는 3단계에서 만듦)
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint bk_notes_kind_check   check (kind in ('capture','thought')),
  constraint bk_notes_body_length  check (char_length(body) <= 20000),
  constraint bk_notes_page_check   check (page is null or page >= 0)
);
create index bk_notes_shelf_idx on public.bk_notes (shelf_id, created_at desc);
create index bk_notes_user_idx  on public.bk_notes (user_id, created_at desc);


-- 7) 밑줄 -----------------------------------------------------------
create table public.bk_highlights (
  id            uuid primary key default gen_random_uuid(),
  note_id       uuid not null references public.bk_notes(id) on delete cascade,
  user_id       uuid not null references public.bk_users(id) on delete cascade,
  shelf_id      uuid not null references public.bk_shelf(id) on delete cascade,
  text          text not null,                          -- 밑줄 문장을 따로 복사해 저장
  start_offset  int,
  end_offset    int,
  created_at    timestamptz not null default now(),
  constraint bk_highlights_text_length check (char_length(text) between 1 and 5000)
);
create index bk_highlights_note_idx on public.bk_highlights (note_id);
create index bk_highlights_user_idx on public.bk_highlights (user_id, created_at desc);


-- 8) 글자 읽기(구글 Vision) 사용 기록 ------------------------------------
create table public.bk_ocr_usage (
  id           bigint generated always as identity primary key,
  user_id      uuid not null references public.bk_users(id) on delete cascade,
  used_at      timestamptz not null default now(),
  used_on      date not null default ((now() at time zone 'Asia/Seoul')::date),  -- 한국 날짜
  ok           boolean not null,
  image_bytes  int,
  error        text
);
create index bk_ocr_usage_user_day_idx on public.bk_ocr_usage (user_id, used_on);


-- 9) 앱 설정값 (관리자가 바꿈) -------------------------------------------
create table public.bk_settings (
  key         text primary key,
  value       jsonb not null,
  updated_at  timestamptz not null default now(),
  updated_by  uuid references public.bk_users(id) on delete set null
);
insert into public.bk_settings (key, value) values ('ocr_daily_limit', '100'::jsonb);


-- 10) 잠금: 화면용 키는 접근 금지, 엣지함수(service_role)만 허용 -----------
alter table public.bk_users        enable row level security;
alter table public.bk_sessions     enable row level security;
alter table public.bk_books        enable row level security;
alter table public.bk_shelf        enable row level security;
alter table public.bk_reading_logs enable row level security;
alter table public.bk_notes        enable row level security;
alter table public.bk_highlights   enable row level security;
alter table public.bk_ocr_usage    enable row level security;
alter table public.bk_settings     enable row level security;
-- (정책은 일부러 만들지 않음 → anon·authenticated 는 행을 하나도 볼 수 없음)

revoke all on table
  public.bk_users, public.bk_sessions, public.bk_books, public.bk_shelf,
  public.bk_reading_logs, public.bk_notes, public.bk_highlights,
  public.bk_ocr_usage, public.bk_settings
from anon, authenticated;
revoke all on sequence public.bk_ocr_usage_id_seq from anon, authenticated;

grant select, insert, update, delete on table
  public.bk_users, public.bk_sessions, public.bk_books, public.bk_shelf,
  public.bk_reading_logs, public.bk_notes, public.bk_highlights,
  public.bk_ocr_usage, public.bk_settings
to service_role;
grant usage, select on sequence public.bk_ocr_usage_id_seq to service_role;

commit;
-- 끝. (bk_ 가 아닌 것은 하나도 만들거나 고치지 않음)
