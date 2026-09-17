// bk-api — 내 서재 · 메모 · 사진 · 독서 시간 · 공개 · 통계 (v5, 2026-09-17 · 5단계)
//   /shelf/list          내 서재 목록
//   /shelf/add           서재에 책 넣기 (ISBN → 카카오 정보로 저장 / 직접 입력)
//   /shelf/get           책 한 권 자세히
//   /shelf/update        상태 · 날짜 · 쪽수 바꾸기
//   /shelf/remove        서재에서 빼기 (그 책의 기록 · 남긴 사진도 함께 지워짐, 책 정보는 남음)
//   /notes/list          메모 목록 (책 하나 또는 전체)
//   /notes/get           메모 하나 (밑줄 · 사진 보기 주소 포함)
//   /notes/add           메모 저장 (찍은 문장 / 내 생각, 사진 · 밑줄 함께)
//   /notes/update        메모 글 · 쪽수 · 한마디 고치기
//   /notes/remove        메모 지우기 (밑줄 · 사진도)
//   /notes/photo-remove  메모에 남긴 사진만 지우기
//   /photos/list         남긴 사진 모아 보기 (볼 때만 잠깐 열리는 주소 포함)
//   /logs/running        돌고 있는 타이머 (없으면 null) + 서버 시각
//   /logs/start          타이머 시작 (한 사람 하나)
//   /logs/stop           타이머 멈추고 저장 (읽은 분 · 끝낸 쪽)
//   /logs/cancel         타이머를 기록하지 않고 끝내기
//   /logs/add            손으로 적기 (날짜 · 분 · 끝낸 쪽)
//   /logs/list           책 한 권의 독서 시간 목록 · 합계
//   /logs/update         독서 시간 고치기
//   /logs/remove         독서 시간 지우기
//   /stats               달별 통계 (권수 · 시간 · 하루 평균 · 달력 · 다 읽은 책 · 읽는 중)
//   /stats/streak        이어서 읽은 날 · 최고 기록 · 오늘 읽은 시간 (서재 화면용)
//   /public/users        공개한 책이 있는 회원 목록
//   /public/shelf        그 회원이 공개한 책장
//   /public/book         공개한 책 한 권의 기록 전체 (시간 · 메모 · 사진)
//   /public/recent       최근 공개된 문장 모음
//   /highlights/*        (1.3.0 부터 화면에서 안 씀, 남겨 둠)
//   /highlights/list     밑줄 모아 보기
//   /highlights/add      저장된 메모에 밑줄 더하기
//   /highlights/remove   밑줄 지우기
import { decodeImage, json, kakaoSearch, kstToday, requireApproved, serve, str, supa, UserError, validIsbn13 } from "./common.ts";

const STATUSES = ["want", "reading", "finished", "stopped"] as const;
type Status = typeof STATUSES[number];
const SHELF_SELECT = "id, status, started_on, finished_on, total_pages, current_page, is_public, created_at, updated_at, book:bk_books(id, isbn13, title, authors, translators, publisher, published_on, cover_url, description, source)";

function pages(v: unknown, label: string, max = 20000): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > max) throw new UserError(400, `${label}는 0~${max} 사이 숫자로 적어 주세요.`);
  return n;
}
function dateOrNull(v: unknown, label: string): string | null {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v) || isNaN(Date.parse(v))) throw new UserError(400, `${label}이 올바른 날짜가 아니에요.`);
  if (v > kstToday()) throw new UserError(400, `${label}은 오늘 이후로 정할 수 없어요.`);
  return v;
}
function status(v: unknown, fallback: Status): Status {
  if (v === undefined || v === null || v === "") return fallback;
  if (!STATUSES.includes(v as Status)) throw new UserError(400, "책 상태가 올바르지 않아요.");
  return v as Status;
}

async function findOrCreateBook(body: Record<string, unknown>, userId: string): Promise<string> {
  const isbnRaw = str(body, "isbn", 20).replace(/[^0-9]/g, "");
  const manual = body.manual && typeof body.manual === "object" ? body.manual as Record<string, unknown> : null;

  if (!manual) {
    if (!validIsbn13(isbnRaw)) throw new UserError(400, "책을 골라 주세요.");
    const { data: known } = await supa.from("bk_books").select("id").eq("isbn13", isbnRaw).maybeSingle();
    if (known) return known.id;
    // 화면이 보낸 책 정보는 믿지 않고, 서버가 카카오에서 다시 받아 저장한다
    const r = await kakaoSearch(isbnRaw, "isbn", 1, 5);
    const b = r.books.find((x) => x.isbn13 === isbnRaw);
    if (!b) throw new UserError(404, "이 ISBN으로 책을 찾지 못했어요. [직접 입력]으로 넣어 주세요.", "NOT_FOUND");
    const { data, error } = await supa.from("bk_books").insert({ ...b, source: "kakao", created_by: userId }).select("id").single();
    if (error?.code === "23505") {
      const { data: again } = await supa.from("bk_books").select("id").eq("isbn13", isbnRaw).single();
      return again!.id;
    }
    if (error || !data) throw new Error("책 저장 실패: " + error?.message);
    return data.id;
  }

  const title = str(manual, "title", 200);
  if (!title) throw new UserError(400, "책 제목을 적어 주세요.");
  const authors = str(manual, "authors", 300).split(/[,，]/).map((a) => a.trim()).filter(Boolean).slice(0, 10);
  const publisher = str(manual, "publisher", 100) || null;
  const misbn = str(manual, "isbn", 20).replace(/[^0-9]/g, "");
  if (misbn && !validIsbn13(misbn)) throw new UserError(400, "ISBN은 978 또는 979로 시작하는 13자리 숫자예요. 모르면 비워 두세요.");
  if (misbn) {
    const { data: known } = await supa.from("bk_books").select("id").eq("isbn13", misbn).maybeSingle();
    if (known) return known.id;
  }
  const { data, error } = await supa.from("bk_books").insert({
    isbn13: misbn || null, title, authors, publisher, source: "manual", created_by: userId,
  }).select("id").single();
  if (error || !data) throw new Error("책 저장 실패: " + error?.message);
  return data.id;
}

async function ownShelf(body: Record<string, unknown>, userId: string) {
  const id = str(body, "shelf_id", 40);
  if (!UUID.test(id)) throw new UserError(400, "책을 골라 주세요.");
  const { data } = await supa.from("bk_shelf").select(SHELF_SELECT).eq("id", id).eq("user_id", userId).maybeSingle();
  if (!data) throw new UserError(404, "서재에서 이 책을 찾을 수 없어요.", "NOT_FOUND");
  return data as Record<string, unknown>;
}

// ── 메모 · 밑줄 · 사진 도우미 (3단계) ──────────────────────────────────
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const BUCKET = "bk-photos";                 // 비공개 사진 창고 (bk_002)
const PHOTO_MAX_BYTES = 2 * 1024 * 1024;    // 창고 설정과 같은 2MB (화면은 보통 0.3MB 안팎으로 줄여 보냄)
const PHOTO_URL_SECONDS = 600;              // 사진 보기 주소는 10분만 열림
const MAX_LIST = 1000;
const MAX_HIGHLIGHTS = 50;
const NOTE_LIST_SELECT = "id, shelf_id, kind, body, page, thought, photo_path, created_at, updated_at, shelf:bk_shelf(id, book:bk_books(id, title, authors, cover_url)), highlights:bk_highlights(id, text, start_offset, end_offset, created_at)";
const HIGHLIGHT_LIST_SELECT = "id, note_id, shelf_id, text, start_offset, end_offset, created_at, note:bk_notes(id, page, kind), shelf:bk_shelf(id, book:bk_books(id, title, authors, cover_url))";

function noteBody(v: unknown): string {
  if (v === undefined || v === null) return "";
  if (typeof v !== "string") throw new UserError(400, "글자가 올바르지 않아요.");
  const t = v.replace(/\r\n?/g, "\n").replace(/[ \t]+$/gm, "").trim();
  if (t.length > 20000) throw new UserError(400, "메모가 너무 길어요. 20000자까지 적을 수 있어요.");
  return t;
}

function thoughtText(v: unknown): string | null {
  if (v === undefined || v === null || v === "") return null;
  if (typeof v !== "string") throw new UserError(400, "내 생각 한마디가 올바르지 않아요.");
  const t = v.replace(/\r\n?/g, "\n").trim();
  if (t.length > 2000) throw new UserError(400, "내 생각 한마디는 2000자까지 적을 수 있어요.");
  return t || null;
}

/** 밑줄 위치를 서버가 다시 확인하고, 밑줄 문장은 메모 글에서 직접 잘라 복사한다 (화면이 보낸 문장은 믿지 않음) */
function highlightInputs(v: unknown, text: string): { start: number; end: number; text: string }[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw new UserError(400, "밑줄 정보가 올바르지 않아요.");
  if (v.length > MAX_HIGHLIGHTS) throw new UserError(400, `한 메모에는 밑줄을 ${MAX_HIGHLIGHTS}개까지 그을 수 있어요.`);
  return v.map((h) => {
    const o = (h && typeof h === "object" ? h : {}) as Record<string, unknown>;
    let start = Number(o.start), end = Number(o.end);
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end > text.length || end <= start) {
      throw new UserError(400, "밑줄 위치가 글과 맞지 않아요. 밑줄을 다시 그어 주세요.");
    }
    // 앞뒤 공백은 밑줄에서 뺀다
    while (start < end && /\s/.test(text[start])) start++;
    while (end > start && /\s/.test(text[end - 1])) end--;
    const piece = text.slice(start, end);
    if (!piece) throw new UserError(400, "밑줄 위치가 글과 맞지 않아요. 밑줄을 다시 그어 주세요.");
    if (piece.length > 5000) throw new UserError(400, "밑줄 한 개는 5000자까지 그을 수 있어요.");
    return { start, end, text: piece };
  });
}

async function ownNote(body: Record<string, unknown>, userId: string) {
  const id = str(body, "note_id", 40);
  if (!UUID.test(id)) throw new UserError(400, "메모를 골라 주세요.");
  const { data, error } = await supa.from("bk_notes").select(NOTE_LIST_SELECT).eq("id", id).eq("user_id", userId).maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new UserError(404, "메모를 찾을 수 없어요. 이미 지웠을 수 있어요.", "NOT_FOUND");
  return data as Record<string, unknown>;
}

function noteOut(n: Record<string, unknown>) {
  const shelf = (n.shelf ?? {}) as Record<string, unknown>;
  const hl = (Array.isArray(n.highlights) ? n.highlights : []) as Record<string, unknown>[];
  return {
    id: n.id, shelf_id: n.shelf_id, kind: n.kind, body: n.body, page: n.page, thought: n.thought ?? null,
    has_photo: !!n.photo_path, created_at: n.created_at, updated_at: n.updated_at,
    book: shelf.book ?? null,
    highlights: hl.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at))),
  };
}

function highlightOut(h: Record<string, unknown>) {
  const shelf = (h.shelf ?? {}) as Record<string, unknown>;
  const note = (h.note ?? {}) as Record<string, unknown>;
  return {
    id: h.id, note_id: h.note_id, shelf_id: h.shelf_id, text: h.text, start_offset: h.start_offset, end_offset: h.end_offset,
    created_at: h.created_at, page: note.page ?? null, kind: note.kind ?? null, book: shelf.book ?? null,
  };
}

/** 사진 지우기. 실패해도 메모 쪽 일은 이미 끝났으므로 기록만 남기고 넘어간다 */
async function removePhotos(paths: string[]) {
  const list = paths.filter(Boolean);
  if (!list.length) return;
  const { error } = await supa.storage.from(BUCKET).remove(list);
  if (error) console.error("[bk-api] 사진 지우기 실패", list.length, error.message);
}

/** 기록을 남기면 서재 목록에서 그 책이 위로 오게 */
async function touchShelf(shelfId: string) {
  await supa.from("bk_shelf").update({ updated_at: new Date().toISOString() }).eq("id", shelfId);
}

// ── 독서 시간 도우미 (4단계) ──────────────────────────────────
const LOG_SELECT = "id, shelf_id, method, started_at, ended_at, minutes, read_on, end_page, created_at, shelf:bk_shelf(id, status, started_on, total_pages, current_page, book:bk_books(id, title, authors, cover_url))";

/** 시각 → 한국 날짜 (자정을 넘겨 읽어도 시작한 날로 친다) */
function kstDateOf(d: Date): string {
  return new Date(d.getTime() + 9 * 3600000).toISOString().slice(0, 10);
}

function readMinutes(v: unknown): number {
  const n = Number(v);
  if (v === null || v === undefined || v === "" || !Number.isInteger(n) || n < 0 || n > 1440) {
    throw new UserError(400, "읽은 시간은 1~1440분(24시간) 사이 숫자로 적어 주세요.");
  }
  return n;
}

function readEndPage(v: unknown, shelf: Record<string, unknown> | null): number | null {
  const p = pages(v, "끝낸 쪽");
  const total = shelf?.total_pages as number | null | undefined;
  if (p !== null && total && p > total) throw new UserError(400, `끝낸 쪽이 전체 쪽수(${total}쪽)보다 많아요.`);
  return p;
}

/** 끝낸 쪽이 지금 읽은 쪽보다 뒤면 서재의 「읽은 쪽」도 옮긴다 */
async function moveCurrentPage(shelf: Record<string, unknown>, endPage: number | null, userId: string) {
  const upd: Record<string, unknown> = { updated_at: new Date().toISOString() };
  const cur = shelf.current_page as number | null;
  if (endPage !== null && (cur === null || cur === undefined || endPage > cur)) upd.current_page = endPage;
  await supa.from("bk_shelf").update(upd).eq("id", shelf.id).eq("user_id", userId);
}

async function ownLog(body: Record<string, unknown>, userId: string) {
  const id = str(body, "log_id", 40);
  if (!UUID.test(id)) throw new UserError(400, "독서 기록을 골라 주세요.");
  const { data, error } = await supa.from("bk_reading_logs").select(LOG_SELECT).eq("id", id).eq("user_id", userId).maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new UserError(404, "독서 기록을 찾을 수 없어요. 이미 지웠을 수 있어요.", "NOT_FOUND");
  return data as Record<string, unknown>;
}

// ── 통계 · 공개 도우미 (5단계) ─────────────────────────────────
const PUBLIC_BOOK_SELECT = "id, user_id, status, started_on, finished_on, total_pages, current_page, updated_at, book:bk_books(id, title, authors, translators, publisher, published_on, cover_url, description)";

/** 한 달의 첫날 · 다음 달 첫날 (YYYY-MM-DD) */
function monthRange(m: string): { start: string; next: string; days: number } {
  const [y, mo] = m.split("-").map(Number);
  const start = `${y}-${String(mo).padStart(2, "0")}-01`;
  const ny = mo === 12 ? y + 1 : y;
  const nm = mo === 12 ? 1 : mo + 1;
  return { start, next: `${ny}-${String(nm).padStart(2, "0")}-01`, days: new Date(Date.UTC(ny, nm - 1, 1) - 86400000).getUTCDate() };
}

function monthOf(v: unknown): string {
  const t = typeof v === "string" ? v.trim() : "";
  if (!t) return kstToday().slice(0, 7);
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(t) || t < "2000-01" || t > "2999-12") throw new UserError(400, "달을 올바르게 골라 주세요.");
  return t;
}

const dayAfter = (iso: string) => new Date(Date.parse(iso + "T00:00:00Z") + 86400000).toISOString().slice(0, 10);

/** 내 독서 시간 기록의 날짜별 분 (읽은 날 → 분). 1000줄씩 나눠 읽는다 */
async function minutesByDay(userId: string, from?: string, to?: string): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  for (let start = 0; start < 20000; start += 1000) {
    let q = supa.from("bk_reading_logs").select("read_on, minutes, shelf_id, ended_at, method")
      .eq("user_id", userId).not("minutes", "is", null);
    if (from) q = q.gte("read_on", from);
    if (to) q = q.lt("read_on", to);
    const { data, error } = await q.order("read_on", { ascending: true }).range(start, start + 999);
    if (error) throw new Error(error.message);
    for (const r of data ?? []) {
      if (r.method === "timer" && !r.ended_at) continue;
      out.set(r.read_on as string, (out.get(r.read_on as string) ?? 0) + ((r.minutes as number) ?? 0));
    }
    if (!data || data.length < 1000) break;
  }
  return out;
}

/** 이어서 읽은 날: 오늘(또는 어제)부터 끊기지 않고 이어진 날수 + 가장 길었던 기록 */
function streakOf(days: string[]): { streak: number; best: number } {
  const set = new Set(days);
  const sorted = [...set].sort();
  let best = 0;
  let run = 0;
  let prev = "";
  for (const d of sorted) {
    run = prev && dayAfter(prev) === d ? run + 1 : 1;
    prev = d;
    if (run > best) best = run;
  }
  const today = kstToday();
  const yesterday = new Date(Date.parse(today + "T00:00:00Z") - 86400000).toISOString().slice(0, 10);
  let cur = set.has(today) ? today : set.has(yesterday) ? yesterday : "";
  let streak = 0;
  while (cur && set.has(cur)) {
    streak++;
    cur = new Date(Date.parse(cur + "T00:00:00Z") - 86400000).toISOString().slice(0, 10);
  }
  return { streak, best };
}

/** 공개된 책인지 확인하고 돌려준다 (누구 책이든 공개면 볼 수 있음) */
async function publicShelf(body: Record<string, unknown>) {
  const id = str(body, "shelf_id", 40);
  if (!UUID.test(id)) throw new UserError(400, "책을 골라 주세요.");
  const { data, error } = await supa.from("bk_shelf").select(PUBLIC_BOOK_SELECT).eq("id", id).eq("is_public", true).maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new UserError(404, "지금은 볼 수 없는 책이에요. 공개가 꺼졌을 수 있어요.", "NOT_PUBLIC");
  return data as Record<string, unknown>;
}

async function userMap(ids: string[]): Promise<Map<string, { display_name: string; username: string }>> {
  const out = new Map<string, { display_name: string; username: string }>();
  if (!ids.length) return out;
  const { data } = await supa.from("bk_users").select("id, display_name, username").in("id", [...new Set(ids)]);
  for (const u of data ?? []) out.set(u.id as string, { display_name: u.display_name as string, username: u.username as string });
  return out;
}

serve("bk-api", {
  "/shelf/list": async (_req, body) => {
    const { user } = await requireApproved(body);
    const { data, error } = await supa.from("bk_shelf").select(SHELF_SELECT)
      .eq("user_id", user.id).order("updated_at", { ascending: false }).limit(500);
    if (error) throw new Error(error.message);
    return json(200, { items: data ?? [] });
  },

  "/shelf/add": async (_req, body) => {
    const { user } = await requireApproved(body);
    const st = status(body.status, "reading");
    const total = pages(body.total_pages, "전체 쪽수");
    if (total === 0) throw new UserError(400, "전체 쪽수는 1 이상으로 적어 주세요.");
    const bookId = await findOrCreateBook(body, user.id);
    const today = kstToday();
    const { data, error } = await supa.from("bk_shelf").insert({
      user_id: user.id, book_id: bookId, status: st, total_pages: total,
      started_on: st === "reading" || st === "finished" ? today : null,
      finished_on: st === "finished" ? today : null,
      current_page: st === "finished" && total ? total : null,
    }).select(SHELF_SELECT).single();
    if (error?.code === "23505") {
      const { data: dup } = await supa.from("bk_shelf").select("id").eq("user_id", user.id).eq("book_id", bookId).single();
      throw new UserError(409, "이미 내 서재에 있는 책이에요.", "ALREADY:" + dup?.id);
    }
    if (error || !data) throw new Error("서재 저장 실패: " + error?.message);
    return json(200, { item: data });
  },

  "/shelf/get": async (_req, body) => {
    const { user } = await requireApproved(body);
    return json(200, { item: await ownShelf(body, user.id) });
  },

  "/shelf/update": async (_req, body) => {
    const { user } = await requireApproved(body);
    const cur = await ownShelf(body, user.id);
    const upd: Record<string, unknown> = { updated_at: new Date().toISOString() };
    const today = kstToday();

    let total = cur.total_pages as number | null;
    if ("total_pages" in body) {
      total = pages(body.total_pages, "전체 쪽수");
      if (total === 0) throw new UserError(400, "전체 쪽수는 1 이상으로 적어 주세요.");
      upd.total_pages = total;
    }
    let current = cur.current_page as number | null;
    if ("current_page" in body) { current = pages(body.current_page, "읽은 쪽수"); upd.current_page = current; }
    if (total !== null && current !== null && current > total) throw new UserError(400, "읽은 쪽수가 전체 쪽수보다 많아요.");

    if ("status" in body) {
      const st = status(body.status, cur.status as Status);
      upd.status = st;
      if ((st === "reading" || st === "finished") && !cur.started_on && !("started_on" in body)) upd.started_on = today;
      if (st === "finished") {
        if (!cur.finished_on && !("finished_on" in body)) upd.finished_on = today;
        if (total !== null && !("current_page" in body)) upd.current_page = total;
      } else if (cur.status === "finished" && !("finished_on" in body)) {
        upd.finished_on = null;
      }
    }
    if ("is_public" in body) {
      if (typeof body.is_public !== "boolean") throw new UserError(400, "공개 설정이 올바르지 않아요.");
      upd.is_public = body.is_public;
    }
    if ("started_on" in body) upd.started_on = dateOrNull(body.started_on, "시작한 날");
    if ("finished_on" in body) upd.finished_on = dateOrNull(body.finished_on, "다 읽은 날");
    const s = (upd.started_on ?? cur.started_on) as string | null;
    const f = (upd.finished_on !== undefined ? upd.finished_on : cur.finished_on) as string | null;
    if (s && f && f < s) throw new UserError(400, "다 읽은 날이 시작한 날보다 빨라요.");

    const { data, error } = await supa.from("bk_shelf").update(upd).eq("id", cur.id).eq("user_id", user.id)
      .select(SHELF_SELECT).single();
    if (error || !data) throw new Error("서재 저장 실패: " + error?.message);
    return json(200, { item: data });
  },

  "/shelf/remove": async (_req, body) => {
    const { user } = await requireApproved(body);
    const cur = await ownShelf(body, user.id);
    // 그 책 메모에 남긴 사진 목록을 먼저 챙긴다 (표를 지우면 사진 위치를 잃음)
    const { data: withPhoto, error: pErr } = await supa.from("bk_notes").select("photo_path")
      .eq("shelf_id", cur.id).eq("user_id", user.id).not("photo_path", "is", null);
    if (pErr) throw new Error(pErr.message);
    const { error } = await supa.from("bk_shelf").delete().eq("id", cur.id).eq("user_id", user.id);
    if (error) throw new Error(error.message);
    await removePhotos((withPhoto ?? []).map((n) => n.photo_path as string));
    return json(200, { ok: true });
  },

  // ── 메모 ────────────────────────────────────────────────
  "/notes/list": async (_req, body) => {
    const { user } = await requireApproved(body);
    let q = supa.from("bk_notes").select(NOTE_LIST_SELECT).eq("user_id", user.id);
    if (body.shelf_id !== undefined && body.shelf_id !== null && body.shelf_id !== "") {
      const shelf = await ownShelf(body, user.id);
      q = q.eq("shelf_id", shelf.id);
    }
    const { data, error } = await q.order("created_at", { ascending: false }).limit(MAX_LIST);
    if (error) throw new Error(error.message);
    return json(200, { items: (data ?? []).map(noteOut), limit: MAX_LIST });
  },

  "/notes/get": async (_req, body) => {
    const { user } = await requireApproved(body);
    const note = await ownNote(body, user.id);
    let photo_url: string | null = null;
    if (note.photo_path) {
      const { data, error } = await supa.storage.from(BUCKET).createSignedUrl(note.photo_path as string, PHOTO_URL_SECONDS);
      if (error) console.error("[bk-api] 사진 주소 만들기 실패", error.message);
      photo_url = data?.signedUrl ?? null;
    }
    return json(200, { item: { ...noteOut(note), photo_url, photo_url_seconds: PHOTO_URL_SECONDS } });
  },

  "/notes/add": async (_req, body) => {
    const { user } = await requireApproved(body);
    const shelf = await ownShelf(body, user.id);
    const kind = body.kind === "thought" ? "thought" : body.kind === "capture" ? "capture" : "";
    if (!kind) throw new UserError(400, "메모 종류가 올바르지 않아요.");
    const text = noteBody(body.body);
    const page = pages(body.page, "쪽수");
    const thought = kind === "capture" ? thoughtText(body.thought) : null;
    const wantPhoto = kind === "capture" && body.keep_photo === true && typeof body.photo === "string" && body.photo !== "";
    if (!text && !wantPhoto) throw new UserError(400, kind === "thought" ? "메모 내용을 적어 주세요." : "글자를 적어 주세요.");
    const marks = highlightInputs(body.highlights, text);

    const noteId = crypto.randomUUID();
    let photoPath: string | null = null;
    if (wantPhoto) {
      const img = decodeImage(body.photo, PHOTO_MAX_BYTES);
      photoPath = `${user.id}/${noteId}.${img.mime === "image/png" ? "png" : img.mime === "image/webp" ? "webp" : "jpg"}`;
      const { error: upErr } = await supa.storage.from(BUCKET).upload(photoPath, img.bytes, { contentType: img.mime, upsert: false });
      if (upErr) {
        console.error("[bk-api] 사진 올리기 실패", upErr.message);
        throw new UserError(502, "사진을 저장하지 못했어요. [사진도 남기기]를 끄고 글자만 저장하거나, 잠시 뒤 다시 해 주세요.", "PHOTO_UPLOAD");
      }
    }
    const { error } = await supa.from("bk_notes").insert({
      id: noteId, user_id: user.id, shelf_id: shelf.id, kind, body: text, page, thought, photo_path: photoPath,
    });
    if (error) {
      if (photoPath) await removePhotos([photoPath]);
      throw new Error("메모 저장 실패: " + error.message);
    }
    if (marks.length) {
      const { error: hErr } = await supa.from("bk_highlights").insert(marks.map((m) => ({
        note_id: noteId, user_id: user.id, shelf_id: shelf.id, text: m.text, start_offset: m.start, end_offset: m.end,
      })));
      if (hErr) {
        await supa.from("bk_notes").delete().eq("id", noteId);
        if (photoPath) await removePhotos([photoPath]);
        throw new Error("밑줄 저장 실패: " + hErr.message);
      }
    }
    // [사진도 남기기] 마지막 선택을 계정에 기억 (찍은 문장을 저장할 때만)
    let keepPhoto = user.keep_photo;
    if (kind === "capture" && typeof body.keep_photo === "boolean" && body.keep_photo !== user.keep_photo) {
      const { error: kErr } = await supa.from("bk_users").update({ keep_photo: body.keep_photo }).eq("id", user.id);
      if (kErr) console.error("[bk-api] keep_photo 저장 실패", kErr.message);
      else keepPhoto = body.keep_photo;
    }
    await touchShelf(shelf.id as string);
    const saved = await ownNote({ note_id: noteId }, user.id);
    return json(200, { item: noteOut(saved), keep_photo: keepPhoto });
  },

  "/notes/update": async (_req, body) => {
    const { user } = await requireApproved(body);
    const note = await ownNote(body, user.id);
    const upd: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if ("body" in body) {
      const text = noteBody(body.body);
      if (!text && !note.photo_path) throw new UserError(400, "글자를 적어 주세요. 메모를 없애려면 [지우기]를 눌러 주세요.");
      upd.body = text;
    }
    if ("page" in body) upd.page = pages(body.page, "쪽수");
    if ("thought" in body) {
      if (note.kind !== "capture") throw new UserError(400, "내 생각 메모에는 한마디를 따로 달 수 없어요.");
      upd.thought = thoughtText(body.thought);
    }
    const { error } = await supa.from("bk_notes").update(upd).eq("id", note.id).eq("user_id", user.id);
    if (error) throw new Error("메모 저장 실패: " + error.message);
    // 글이 바뀌면 밑줄 자리를 다시 찾는다. 밑줄 문장(복사본)은 그대로 두고, 못 찾으면 자리만 비움
    if (typeof upd.body === "string" && upd.body !== note.body) {
      const newBody = upd.body;
      for (const h of (note.highlights ?? []) as { id: string; text: string; start_offset: number | null; end_offset: number | null }[]) {
        const s = h.start_offset, e = h.end_offset;
        if (s !== null && e !== null && newBody.slice(s, e) === h.text) continue;
        const i = newBody.indexOf(h.text);
        const ns = i >= 0 ? i : null, ne = i >= 0 ? i + h.text.length : null;
        if (ns === s && ne === e) continue;
        const { error: hErr } = await supa.from("bk_highlights").update({ start_offset: ns, end_offset: ne })
          .eq("id", h.id).eq("user_id", user.id);
        if (hErr) console.error("[bk-api] 밑줄 자리 고치기 실패", hErr.message);
      }
    }
    return json(200, { item: noteOut(await ownNote(body, user.id)) });
  },

  "/notes/remove": async (_req, body) => {
    const { user } = await requireApproved(body);
    const note = await ownNote(body, user.id);
    const { error } = await supa.from("bk_notes").delete().eq("id", note.id).eq("user_id", user.id);
    if (error) throw new Error(error.message);
    if (note.photo_path) await removePhotos([note.photo_path as string]);
    return json(200, { ok: true });
  },

  "/notes/photo-remove": async (_req, body) => {
    const { user } = await requireApproved(body);
    const note = await ownNote(body, user.id);
    if (!note.photo_path) return json(200, { item: noteOut(note) });
    if (!String(note.body ?? "").trim()) throw new UserError(400, "글자가 없는 메모라 사진만 지울 수 없어요. 메모를 지워 주세요.");
    const { error } = await supa.from("bk_notes").update({ photo_path: null, updated_at: new Date().toISOString() })
      .eq("id", note.id).eq("user_id", user.id);
    if (error) throw new Error(error.message);
    await removePhotos([note.photo_path as string]);
    return json(200, { item: noteOut(await ownNote(body, user.id)) });
  },

  // ── 독서 시간 (4단계) ─────────────────────────────────────
  "/logs/running": async (_req, body) => {
    const { user } = await requireApproved(body);
    const { data, error } = await supa.from("bk_reading_logs").select(LOG_SELECT)
      .eq("user_id", user.id).eq("method", "timer").is("ended_at", null).maybeSingle();
    if (error) throw new Error(error.message);
    return json(200, { item: data ?? null, now: new Date().toISOString() });
  },

  "/logs/start": async (_req, body) => {
    const { user } = await requireApproved(body);
    const shelf = await ownShelf(body, user.id);
    const running = async () => {
      const { data } = await supa.from("bk_reading_logs").select(LOG_SELECT)
        .eq("user_id", user.id).eq("method", "timer").is("ended_at", null).maybeSingle();
      return data as Record<string, unknown> | null;
    };
    const busyWith = (r: Record<string, unknown>) => {
      const t = ((r.shelf as Record<string, unknown> | null)?.book as Record<string, unknown> | null)?.title ?? "다른 책";
      return new UserError(409, r.shelf_id === shelf.id ? "이 책 타이머가 이미 돌고 있어요." : `「${t}」 타이머가 돌고 있어요. 그 타이머를 먼저 멈춰 주세요.`, "RUNNING:" + r.shelf_id);
    };
    const already = await running();
    if (already) throw busyWith(already);
    const now = new Date();
    const { data, error } = await supa.from("bk_reading_logs").insert({
      user_id: user.id, shelf_id: shelf.id, method: "timer", started_at: now.toISOString(), read_on: kstDateOf(now),
    }).select(LOG_SELECT).single();
    if (error?.code === "23505") { const r = await running(); if (r) throw busyWith(r); }
    if (error || !data) throw new Error("타이머 시작 실패: " + error?.message);
    // 읽고 싶은 · 그만 읽은 책을 읽기 시작하면 「읽는 중」으로
    if (shelf.status === "want" || shelf.status === "stopped") {
      await supa.from("bk_shelf").update({ status: "reading", started_on: shelf.started_on ?? kstToday(), updated_at: now.toISOString() })
        .eq("id", shelf.id).eq("user_id", user.id);
    } else await touchShelf(shelf.id as string);
    return json(200, { item: data, now: now.toISOString() });
  },

  "/logs/stop": async (_req, body) => {
    const { user } = await requireApproved(body);
    const log = await ownLog(body, user.id);
    if (log.method !== "timer" || log.ended_at) throw new UserError(409, "이미 끝난 타이머예요. 목록을 새로 불러와 주세요.", "NOT_RUNNING");
    const now = new Date();
    const elapsed = (now.getTime() - new Date(log.started_at as string).getTime()) / 60000;
    let minutes: number;
    if (body.minutes === undefined || body.minutes === null || body.minutes === "") minutes = Math.min(1440, Math.round(elapsed));
    else {
      minutes = readMinutes(body.minutes);
      if (minutes > Math.ceil(elapsed) + 1) throw new UserError(400, "읽은 시간이 타이머보다 길어요. 다시 확인해 주세요.");
    }
    if (minutes < 1) throw new UserError(400, "1분 이상 읽었을 때 저장할 수 있어요. 기록하지 않으려면 [기록하지 않고 끝내기]를 눌러 주세요.", "TOO_SHORT");
    const shelf = log.shelf as Record<string, unknown>;
    const endPage = readEndPage(body.end_page, shelf);
    const { error } = await supa.from("bk_reading_logs").update({ ended_at: now.toISOString(), minutes, end_page: endPage })
      .eq("id", log.id).eq("user_id", user.id).is("ended_at", null);
    if (error) throw new Error("타이머 저장 실패: " + error.message);
    await moveCurrentPage(shelf, endPage, user.id);
    return json(200, { item: await ownLog(body, user.id) });
  },

  "/logs/cancel": async (_req, body) => {
    const { user } = await requireApproved(body);
    const log = await ownLog(body, user.id);
    if (log.method !== "timer" || log.ended_at) throw new UserError(409, "이미 끝난 타이머예요. 목록을 새로 불러와 주세요.", "NOT_RUNNING");
    const { error } = await supa.from("bk_reading_logs").delete().eq("id", log.id).eq("user_id", user.id);
    if (error) throw new Error(error.message);
    return json(200, { ok: true });
  },

  "/logs/add": async (_req, body) => {
    const { user } = await requireApproved(body);
    const shelf = await ownShelf(body, user.id);
    const readOn = dateOrNull(body.read_on, "읽은 날") ?? kstToday();
    const minutes = readMinutes(body.minutes);
    if (minutes < 1) throw new UserError(400, "읽은 시간은 1분 이상으로 적어 주세요.");
    const endPage = readEndPage(body.end_page, shelf);
    const { data, error } = await supa.from("bk_reading_logs").insert({
      user_id: user.id, shelf_id: shelf.id, method: "manual", minutes, read_on: readOn, end_page: endPage,
    }).select(LOG_SELECT).single();
    if (error || !data) throw new Error("독서 시간 저장 실패: " + error?.message);
    await moveCurrentPage(shelf, endPage, user.id);
    return json(200, { item: data });
  },

  "/logs/list": async (_req, body) => {
    const { user } = await requireApproved(body);
    const shelf = await ownShelf(body, user.id);
    const { data, error } = await supa.from("bk_reading_logs")
      .select("id, shelf_id, method, started_at, ended_at, minutes, read_on, end_page, created_at")
      .eq("user_id", user.id).eq("shelf_id", shelf.id).not("minutes", "is", null)
      .order("read_on", { ascending: false }).order("created_at", { ascending: false }).limit(500);
    if (error) throw new Error(error.message);
    const items = (data ?? []).filter((x) => x.method === "manual" || x.ended_at);
    return json(200, { items, total_minutes: items.reduce((a, x) => a + (x.minutes ?? 0), 0) });
  },

  "/logs/update": async (_req, body) => {
    const { user } = await requireApproved(body);
    const log = await ownLog(body, user.id);
    if (log.method === "timer" && !log.ended_at) throw new UserError(409, "돌고 있는 타이머는 고칠 수 없어요. 먼저 멈춰 주세요.", "RUNNING");
    const upd: Record<string, unknown> = {};
    if ("read_on" in body) upd.read_on = dateOrNull(body.read_on, "읽은 날") ?? log.read_on;
    if ("minutes" in body) {
      const m = readMinutes(body.minutes);
      if (m < 1) throw new UserError(400, "읽은 시간은 1분 이상으로 적어 주세요.");
      upd.minutes = m;
    }
    if ("end_page" in body) upd.end_page = readEndPage(body.end_page, log.shelf as Record<string, unknown>);
    const { error } = await supa.from("bk_reading_logs").update(upd).eq("id", log.id).eq("user_id", user.id);
    if (error) throw new Error("독서 시간 저장 실패: " + error.message);
    return json(200, { item: await ownLog(body, user.id) });
  },

  "/logs/remove": async (_req, body) => {
    const { user } = await requireApproved(body);
    const log = await ownLog(body, user.id);
    const { error } = await supa.from("bk_reading_logs").delete().eq("id", log.id).eq("user_id", user.id);
    if (error) throw new Error(error.message);
    return json(200, { ok: true });
  },

  // ── 통계 (5단계) ─────────────────────────────────────────
  "/stats": async (_req, body) => {
    const { user } = await requireApproved(body);
    const month = monthOf(body.month);
    const { start, next, days } = monthRange(month);
    const today = kstToday();
    const thisMonth = month === today.slice(0, 7);

    // 그 달의 독서 시간
    const logs: { read_on: string; minutes: number; shelf_id: string }[] = [];
    for (let from = 0; from < 20000; from += 1000) {
      const { data, error } = await supa.from("bk_reading_logs").select("read_on, minutes, shelf_id, ended_at, method")
        .eq("user_id", user.id).not("minutes", "is", null).gte("read_on", start).lt("read_on", next)
        .order("read_on", { ascending: true }).range(from, from + 999);
      if (error) throw new Error(error.message);
      for (const r of data ?? []) {
        if (r.method === "timer" && !r.ended_at) continue;
        logs.push({ read_on: r.read_on as string, minutes: (r.minutes as number) ?? 0, shelf_id: r.shelf_id as string });
      }
      if (!data || data.length < 1000) break;
    }
    const calendar: Record<string, number> = {};
    let longest = 0;
    for (const l of logs) {
      calendar[l.read_on] = (calendar[l.read_on] ?? 0) + l.minutes;
      if (l.minutes > longest) longest = l.minutes;
    }
    const totalMinutes = logs.reduce((a, l) => a + l.minutes, 0);
    const readShelves = new Set(logs.map((l) => l.shelf_id));
    const divisor = thisMonth ? Number(today.slice(8)) : days;

    // 그 달에 다 읽은 책 · 지금 읽는 중인 책
    const { data: finished } = await supa.from("bk_shelf").select(SHELF_SELECT)
      .eq("user_id", user.id).eq("status", "finished").gte("finished_on", start).lt("finished_on", next)
      .order("finished_on", { ascending: false }).limit(200);
    const { data: reading } = await supa.from("bk_shelf").select(SHELF_SELECT)
      .eq("user_id", user.id).eq("status", "reading").order("updated_at", { ascending: false }).limit(50);
    // 그 달에 남긴 메모 수
    const { count: noteCount } = await supa.from("bk_notes").select("id", { count: "exact", head: true })
      .eq("user_id", user.id).gte("created_at", start).lt("created_at", next);
    // 이어서 읽은 날 (전체 기간)
    const allDays = await minutesByDay(user.id);
    const { streak, best } = streakOf([...allDays.keys()]);

    return json(200, {
      month, days, today,
      total_minutes: totalMinutes,
      average_minutes: Math.round(totalMinutes / Math.max(1, divisor)),
      average_over: divisor,
      read_days: Object.keys(calendar).length,
      books_read: readShelves.size,
      books_finished: (finished ?? []).length,
      longest_minutes: longest,
      note_count: noteCount ?? 0,
      streak, best_streak: best,
      calendar,
      finished: finished ?? [],
      reading: reading ?? [],
    });
  },

  "/stats/streak": async (_req, body) => {
    const { user } = await requireApproved(body);
    const days = await minutesByDay(user.id);
    const { streak, best } = streakOf([...days.keys()]);
    return json(200, { streak, best_streak: best, today_minutes: days.get(kstToday()) ?? 0, today: kstToday() });
  },

  // ── 공개 · 둘러보기 (5단계) ────────────────────────────────
  "/public/users": async (_req, body) => {
    const { user } = await requireApproved(body);
    const { data, error } = await supa.from("bk_shelf").select("user_id, updated_at").eq("is_public", true).limit(5000);
    if (error) throw new Error(error.message);
    const counts = new Map<string, { books: number; last: string }>();
    for (const r of data ?? []) {
      const c = counts.get(r.user_id as string) ?? { books: 0, last: "" };
      c.books++;
      if (String(r.updated_at) > c.last) c.last = String(r.updated_at);
      counts.set(r.user_id as string, c);
    }
    const names = await userMap([...counts.keys()]);
    const users = [...counts.entries()].map(([id, c]) => ({
      user_id: id, display_name: names.get(id)?.display_name ?? "회원", username: names.get(id)?.username ?? "",
      books: c.books, last_at: c.last, me: id === user.id,
    })).sort((a, b) => b.books - a.books || a.display_name.localeCompare(b.display_name, "ko"));
    return json(200, { users });
  },

  "/public/shelf": async (_req, body) => {
    await requireApproved(body);
    const id = str(body, "user_id", 40);
    if (!UUID.test(id)) throw new UserError(400, "회원을 골라 주세요.");
    const names = await userMap([id]);
    if (!names.has(id)) throw new UserError(404, "회원을 찾을 수 없어요.", "NOT_FOUND");
    const { data, error } = await supa.from("bk_shelf").select(PUBLIC_BOOK_SELECT)
      .eq("user_id", id).eq("is_public", true).order("updated_at", { ascending: false }).limit(500);
    if (error) throw new Error(error.message);
    const items = (data ?? []) as Record<string, unknown>[];
    const ids = items.map((x) => x.id as string);
    const notes = new Map<string, number>();
    const minutes = new Map<string, number>();
    if (ids.length) {
      const { data: n } = await supa.from("bk_notes").select("shelf_id").in("shelf_id", ids).limit(5000);
      for (const r of n ?? []) notes.set(r.shelf_id as string, (notes.get(r.shelf_id as string) ?? 0) + 1);
      const { data: l } = await supa.from("bk_reading_logs").select("shelf_id, minutes, ended_at, method").in("shelf_id", ids).limit(5000);
      for (const r of l ?? []) {
        if (r.method === "timer" && !r.ended_at) continue;
        minutes.set(r.shelf_id as string, (minutes.get(r.shelf_id as string) ?? 0) + ((r.minutes as number) ?? 0));
      }
    }
    return json(200, {
      owner: { user_id: id, ...names.get(id) },
      items: items.map((x) => ({ ...x, note_count: notes.get(x.id as string) ?? 0, total_minutes: minutes.get(x.id as string) ?? 0 })),
    });
  },

  "/public/book": async (_req, body) => {
    await requireApproved(body);
    const shelf = await publicShelf(body);
    const names = await userMap([shelf.user_id as string]);
    const { data: notes, error } = await supa.from("bk_notes")
      .select("id, kind, body, page, thought, photo_path, created_at")
      .eq("shelf_id", shelf.id).order("created_at", { ascending: false }).limit(MAX_LIST);
    if (error) throw new Error(error.message);
    const rows = (notes ?? []) as Record<string, unknown>[];
    const urls = new Map<string, string>();
    const paths = rows.map((r) => r.photo_path as string).filter(Boolean);
    for (let i = 0; i < paths.length; i += 100) {
      const { data: signed, error: sErr } = await supa.storage.from(BUCKET).createSignedUrls(paths.slice(i, i + 100), PHOTO_URL_SECONDS);
      if (sErr) { console.error("[bk-api] 공개 사진 주소 실패", sErr.message); continue; }
      for (const x of signed ?? []) if (x.path && x.signedUrl) urls.set(x.path, x.signedUrl);
    }
    const { data: logs } = await supa.from("bk_reading_logs").select("id, method, minutes, read_on, end_page, ended_at")
      .eq("shelf_id", shelf.id).not("minutes", "is", null).order("read_on", { ascending: false }).limit(500);
    const done = (logs ?? []).filter((x) => x.method === "manual" || x.ended_at);
    return json(200, {
      item: shelf,
      owner: { user_id: shelf.user_id, ...names.get(shelf.user_id as string) },
      notes: rows.map((r) => ({
        id: r.id, kind: r.kind, body: r.body, page: r.page, thought: r.thought ?? null, created_at: r.created_at,
        photo_url: r.photo_path ? urls.get(r.photo_path as string) ?? null : null,
      })),
      logs: done,
      total_minutes: done.reduce((a, x) => a + ((x.minutes as number) ?? 0), 0),
    });
  },

  "/public/recent": async (_req, body) => {
    await requireApproved(body);
    const { data: shelves, error } = await supa.from("bk_shelf").select("id, user_id, book:bk_books(id, title, cover_url)")
      .eq("is_public", true).limit(1000);
    if (error) throw new Error(error.message);
    const list = (shelves ?? []) as Record<string, unknown>[];
    if (!list.length) return json(200, { items: [] });
    const byShelf = new Map(list.map((x) => [x.id as string, x]));
    const { data: notes } = await supa.from("bk_notes").select("id, shelf_id, kind, body, page, photo_path, created_at")
      .in("shelf_id", [...byShelf.keys()]).neq("body", "").order("created_at", { ascending: false }).limit(50);
    const names = await userMap(list.map((x) => x.user_id as string));
    const items = (notes ?? []).map((n) => {
      const sh = byShelf.get(n.shelf_id as string)!;
      const text = String(n.body ?? "").replace(/\s+/g, " ").trim();
      return {
        note_id: n.id, shelf_id: n.shelf_id, kind: n.kind, page: n.page, created_at: n.created_at,
        has_photo: !!n.photo_path, text: text.length > 200 ? text.slice(0, 200) + "…" : text,
        book: sh.book ?? null, owner: { user_id: sh.user_id, ...names.get(sh.user_id as string) },
      };
    });
    return json(200, { items });
  },

  // ── 사진 모아 보기 ────────────────────────────────────────
  "/photos/list": async (_req, body) => {
    const { user } = await requireApproved(body);
    let q = supa.from("bk_notes").select("id, shelf_id, kind, body, page, photo_path, created_at, shelf:bk_shelf(id, book:bk_books(id, title))")
      .eq("user_id", user.id).not("photo_path", "is", null);
    if (body.shelf_id !== undefined && body.shelf_id !== null && body.shelf_id !== "") {
      const shelf = await ownShelf(body, user.id);
      q = q.eq("shelf_id", shelf.id);
    }
    const { data, error } = await q.order("created_at", { ascending: false }).limit(MAX_LIST);
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as Record<string, unknown>[];
    const urls = new Map<string, string>();
    for (let i = 0; i < rows.length; i += 100) {
      const paths = rows.slice(i, i + 100).map((r) => r.photo_path as string);
      const { data: signed, error: sErr } = await supa.storage.from(BUCKET).createSignedUrls(paths, PHOTO_URL_SECONDS);
      if (sErr) { console.error("[bk-api] 사진 주소 만들기 실패", sErr.message); continue; }
      for (const x of signed ?? []) if (x.path && x.signedUrl) urls.set(x.path, x.signedUrl);
    }
    const items = rows.map((r) => {
      const shelf = (r.shelf ?? {}) as Record<string, unknown>;
      const text = String(r.body ?? "").replace(/\s+/g, " ").trim();
      return {
        note_id: r.id, shelf_id: r.shelf_id, kind: r.kind, page: r.page, created_at: r.created_at,
        preview: text.length > 80 ? text.slice(0, 80) + "…" : text,
        book: shelf.book ?? null, photo_url: urls.get(r.photo_path as string) ?? null,
      };
    });
    return json(200, { items, photo_url_seconds: PHOTO_URL_SECONDS, limit: MAX_LIST });
  },

  // ── 밑줄 (1.3.0 부터 화면에서 쓰지 않음. 예전 기록 보존용으로 남겨 둠) ─────────

  "/highlights/list": async (_req, body) => {
    const { user } = await requireApproved(body);
    let q = supa.from("bk_highlights").select(HIGHLIGHT_LIST_SELECT).eq("user_id", user.id);
    if (body.shelf_id !== undefined && body.shelf_id !== null && body.shelf_id !== "") {
      const shelf = await ownShelf(body, user.id);
      q = q.eq("shelf_id", shelf.id);
    }
    const { data, error } = await q.order("created_at", { ascending: false }).limit(MAX_LIST);
    if (error) throw new Error(error.message);
    return json(200, { items: (data ?? []).map(highlightOut), limit: MAX_LIST });
  },

  "/highlights/add": async (_req, body) => {
    const { user } = await requireApproved(body);
    const note = await ownNote(body, user.id);
    const [m] = highlightInputs([{ start: body.start, end: body.end }], String(note.body ?? ""));
    if (!m) throw new UserError(400, "밑줄 그을 곳을 골라 주세요.");
    const { count } = await supa.from("bk_highlights").select("id", { count: "exact", head: true }).eq("note_id", note.id);
    if ((count ?? 0) >= MAX_HIGHLIGHTS) throw new UserError(400, `한 메모에는 밑줄을 ${MAX_HIGHLIGHTS}개까지 그을 수 있어요.`);
    const { error } = await supa.from("bk_highlights").insert({
      note_id: note.id, user_id: user.id, shelf_id: note.shelf_id, text: m.text, start_offset: m.start, end_offset: m.end,
    });
    if (error) throw new Error("밑줄 저장 실패: " + error.message);
    return json(200, { item: noteOut(await ownNote(body, user.id)) });
  },

  "/highlights/remove": async (_req, body) => {
    const { user } = await requireApproved(body);
    const id = str(body, "highlight_id", 40);
    if (!UUID.test(id)) throw new UserError(400, "밑줄을 골라 주세요.");
    const { data, error } = await supa.from("bk_highlights").delete().eq("id", id).eq("user_id", user.id).select("id");
    if (error) throw new Error(error.message);
    if (!data?.length) throw new UserError(404, "밑줄을 찾을 수 없어요. 이미 지웠을 수 있어요.", "NOT_FOUND");
    return json(200, { ok: true });
  },
});
