// bk-api — 내 서재 · 메모 · 밑줄 (v2, 2026-09-17 · 3단계)
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

  // ── 밑줄 ────────────────────────────────────────────────
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
