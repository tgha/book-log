// bk-api — 내 서재 (v1, 2026-09-17 · 2단계)
//   /shelf/list    내 서재 목록
//   /shelf/add     서재에 책 넣기 (ISBN → 카카오 정보로 저장 / 직접 입력)
//   /shelf/get     책 한 권 자세히
//   /shelf/update  상태 · 날짜 · 쪽수 바꾸기
//   /shelf/remove  서재에서 빼기 (그 책의 기록도 함께 지워짐, 책 정보는 남음)
import { json, kakaoSearch, kstToday, requireApproved, serve, str, supa, UserError, validIsbn13 } from "./common.ts";

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
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new UserError(400, "책을 골라 주세요.");
  const { data } = await supa.from("bk_shelf").select(SHELF_SELECT).eq("id", id).eq("user_id", userId).maybeSingle();
  if (!data) throw new UserError(404, "서재에서 이 책을 찾을 수 없어요.", "NOT_FOUND");
  return data as Record<string, unknown>;
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
    const { error } = await supa.from("bk_shelf").delete().eq("id", cur.id).eq("user_id", user.id);
    if (error) throw new Error(error.message);
    return json(200, { ok: true });
  },
});
