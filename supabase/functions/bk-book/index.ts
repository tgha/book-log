// bk-book — 책 찾기 (v1, 2026-09-17)
//   /search  제목·저자 글자로 찾기 (쪽마다 20권)
//   /isbn    바코드(ISBN-13)로 찾기
// 결과마다 "내 서재에 이미 있는지"(shelf_id)를 붙여 준다.
import { type BookInfo, json, kakaoSearch, requireApproved, serve, str, supa, UserError, validIsbn13 } from "./common.ts";

async function markMine(userId: string, books: BookInfo[]) {
  const isbns = books.map((b) => b.isbn13).filter((x): x is string => !!x);
  const mine: Record<string, string> = {};
  if (isbns.length) {
    const { data: known } = await supa.from("bk_books").select("id, isbn13").in("isbn13", isbns);
    const ids = (known ?? []).map((k) => k.id);
    if (ids.length) {
      const { data: shelf } = await supa.from("bk_shelf").select("id, book_id").eq("user_id", userId).in("book_id", ids);
      for (const s of shelf ?? []) {
        const k = (known ?? []).find((x) => x.id === s.book_id);
        if (k?.isbn13) mine[k.isbn13] = s.id;
      }
    }
  }
  return books.map((b) => ({ ...b, shelf_id: b.isbn13 ? mine[b.isbn13] ?? null : null }));
}

serve("bk-book", {
  "/search": async (_req, body) => {
    const { user } = await requireApproved(body);
    const query = str(body, "query", 100);
    if (query.length < 1) throw new UserError(400, "찾을 책 제목이나 저자를 적어 주세요.");
    const page = Math.min(Math.max(Number(body.page) || 1, 1), 50);
    const r = await kakaoSearch(query, "", page, 20);
    return json(200, { books: await markMine(user.id, r.books), is_end: r.is_end, page });
  },

  "/isbn": async (_req, body) => {
    const { user } = await requireApproved(body);
    const isbn = str(body, "isbn", 20).replace(/[^0-9]/g, "");
    if (!validIsbn13(isbn)) throw new UserError(400, "ISBN 13자리가 맞지 않아요. 978 또는 979로 시작하는 숫자인지 확인해 주세요.");
    const r = await kakaoSearch(isbn, "isbn", 1, 5);
    const exact = r.books.filter((b) => b.isbn13 === isbn);
    if (!exact.length) {
      // 카카오에 없어도 누군가 직접 넣은 책이면 그걸 보여 준다
      const { data: local } = await supa.from("bk_books").select("*").eq("isbn13", isbn).maybeSingle();
      if (local) return json(200, { books: await markMine(user.id, [local as BookInfo]) });
      throw new UserError(404, "이 바코드로 책을 찾지 못했어요. [직접 입력]으로 넣어 주세요.", "NOT_FOUND");
    }
    return json(200, { books: await markMine(user.id, exact.slice(0, 1)) });
  },
});
