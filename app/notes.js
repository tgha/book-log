// book-log 3단계 화면: 메모 · 밑줄 보기 (기록 탭 · 책 자세히의 메모 목록 · 메모 자세히 · 내 생각 쓰기)
// 문장 찍기 흐름은 capture.js
import { api } from "./api.js";
import { busy, confirmBox, formatDate, html, raw, toast } from "./ui.js";

// ── 글 · 밑줄 도우미 (capture.js 와 함께 씀) ──────────────────────
/** 밑줄 위치 찾기: 저장된 위치의 글이 같으면 그 자리, 아니면 같은 문장을 찾아서. 못 찾으면 목록에만 보임 */
export function placeHighlights(body, highlights) {
  const placed = [];
  const unplaced = [];
  for (const h of highlights || []) {
    const s = h.start_offset ?? h.start;
    const e = h.end_offset ?? h.end;
    if (Number.isInteger(s) && Number.isInteger(e) && body.slice(s, e) === h.text) placed.push({ s, e, h });
    else {
      const i = h.text ? body.indexOf(h.text) : -1;
      if (i >= 0) placed.push({ s: i, e: i + h.text.length, h });
      else unplaced.push(h);
    }
  }
  return { placed, unplaced };
}

/** 겹치는 범위를 합쳐 [시작, 끝] 목록으로 */
function mergeRanges(ranges) {
  const r = ranges.map((x) => [x.s, x.e]).sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const [s, e] of r) {
    if (out.length && s <= out[out.length - 1][1]) out[out.length - 1][1] = Math.max(out[out.length - 1][1], e);
    else out.push([s, e]);
  }
  return out;
}

/** 메모 글을 밑줄(형광펜) 표시와 함께 안전한 html 로 */
export function markedBody(body, highlights) {
  const { placed, unplaced } = placeHighlights(body, highlights);
  let out = "";
  let at = 0;
  for (const [s, e] of mergeRanges(placed)) {
    out += html`${body.slice(at, s)}<mark class="hl">${body.slice(s, e)}</mark>`;
    at = e;
  }
  out += html`${body.slice(at)}`;
  return { html: out, unplaced };
}

/** 단어 나누기: 공백이 아닌 덩어리마다 [시작, 끝] */
export function words(text) {
  const out = [];
  const re = /\S+/g;
  let m;
  while ((m = re.exec(text))) out.push([m.index, m.index + m[0].length]);
  return out;
}

/**
 * 단어 눌러 밑줄 고르기. container 안에 단어 단추를 그림.
 * getText() 현재 글, getRanges() 이미 그은 밑줄 [{s,e}], onPick({start,end}|null) 고른 범위가 바뀔 때
 */
export function mountPicker(container, { getText, getRanges, onPick }) {
  let a = null;
  let b = null;
  const draw = () => {
    const text = getText();
    const ws = words(text);
    const ranges = mergeRanges(getRanges());
    const lo = a === null ? -1 : Math.min(a, b ?? a);
    const hi = a === null ? -1 : Math.max(a, b ?? a);
    let out = "";
    let at = 0;
    ws.forEach(([s, e], i) => {
      out += gapHtml(text.slice(at, s));
      const inHl = ranges.some(([rs, re]) => s < re && e > rs);
      const cls = ["w", inHl ? "hl" : "", i >= lo && i <= hi ? "sel" : "", i === a && b === null ? "anchor" : ""].filter(Boolean).join(" ");
      out += html`<button type="button" class="${cls}" data-i="${i}" aria-pressed="${i >= lo && i <= hi}">${text.slice(s, e)}</button>`;
      at = e;
    });
    container.innerHTML = out || '<p class="empty-line">밑줄 그을 글자가 없어요.</p>';
    return ws;
  };
  let ws = draw();
  const report = () => {
    if (a === null || b === null) return onPick(null, a === null ? null : text(a));
    const i = Math.min(a, b);
    const j = Math.max(a, b);
    onPick({ start: ws[i][0], end: ws[j][1] }, null);
  };
  const text = (i) => getText().slice(ws[i][0], ws[i][1]);
  container.addEventListener("click", (e) => {
    const btn = e.target.closest("button.w");
    if (!btn) return;
    const i = Number(btn.dataset.i);
    if (a === null || b !== null) { a = i; b = null; } else b = i;
    ws = draw();
    report();
    container.querySelector(`button.w[data-i="${i}"]`)?.focus();
  });
  return {
    reset() { a = null; b = null; ws = draw(); report(); },
    redraw() { ws = draw(); },
  };
}

function gapHtml(space) {
  if (!space) return "";
  return space.includes("\n") ? "<br>".repeat(Math.min(2, space.split("\n").length - 1)) : " ";
}

// ── 목록 한 줄 ────────────────────────────────────────────
const KIND = { capture: "찍은 문장", thought: "내 생각" };

function noteMeta(n, withBook) {
  const bits = [];
  if (withBook && n.book) bits.push(n.book.title);
  if (n.page !== null && n.page !== undefined) bits.push(`${n.page}쪽`);
  bits.push(KIND[n.kind] || "메모");
  if (n.highlights?.length) bits.push(`밑줄 ${n.highlights.length}`);
  if (n.has_photo) bits.push("사진");
  return bits.join(" · ");
}

function preview(text, max = 160) {
  const t = String(text || "").replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max) + "…" : t;
}

export function noteRow(n, withBook = false) {
  const text = n.body ? preview(n.body) : "(글자 없이 사진만 남긴 메모)";
  return html`<li><a class="note-row" href="#/note/${n.id}">
    <span class="note-meta">${noteMeta(n, withBook)}</span>
    <span class="note-text ${n.kind === "thought" ? "is-thought" : ""}">${text}</span>
    ${raw(n.thought ? html`<span class="note-thought">${preview(n.thought, 80)}</span>` : "")}
  </a></li>`;
}

function highlightRow(h) {
  const bits = [h.book?.title, h.page !== null && h.page !== undefined ? `${h.page}쪽` : "", formatDate(h.created_at)].filter(Boolean);
  return html`<li><a class="hl-row" href="#/note/${h.note_id}">
    <span class="hl-text">${preview(h.text, 400)}</span>
    <span class="note-meta">${bits.join(" · ")}</span>
  </a></li>`;
}

/** 정렬: 작성순(새로 쓴 것 먼저) / 쪽수순(책 이름 → 쪽 → 쓴 순서) */
function sortItems(items, sort) {
  const list = items.slice();
  if (sort === "page") {
    list.sort((x, y) => (x.book?.title || "").localeCompare(y.book?.title || "", "ko")
      || (x.page ?? 1e9) - (y.page ?? 1e9)
      || String(x.created_at).localeCompare(String(y.created_at)));
  } else list.sort((x, y) => String(y.created_at).localeCompare(String(x.created_at)));
  return list;
}

function sortButtons(sort) {
  return html`<div class="segments segments-small" role="group" aria-label="정렬">
    <button type="button" data-sort="recent" aria-pressed="${sort === "recent"}">작성순</button>
    <button type="button" data-sort="page" aria-pressed="${sort === "page"}">쪽수순</button>
  </div>`;
}

// ── 책 자세히 안의 「메모 · 밑줄」 ─────────────────────────────
let bookSort = "recent";
export async function mountBookNotes(ctx, root, shelfId) {
  const route = `book/${shelfId}`;
  root.innerHTML = html`
    <h2>메모 · 밑줄 <span class="count" id="note-count"></span></h2>
    <div class="note-actions">
      <a class="btn btn-primary" href="#/capture/${shelfId}/pick" data-start-capture>문장 찍기</a>
      <a class="btn btn-quiet" href="#/write/${shelfId}">메모 쓰기</a>
    </div>
    <div id="book-notes"><p class="empty-line">불러오는 중…</p></div>`;
  let items;
  try {
    ({ items } = await api.notes.list(shelfId));
  } catch (err) {
    if (ctx.isCurrent(route)) root.querySelector("#book-notes").innerHTML = html`<p class="empty-line">${err.message}</p>`;
    return;
  }
  if (!ctx.isCurrent(route)) return;
  const draw = () => {
    const box = root.querySelector("#book-notes");
    root.querySelector("#note-count").textContent = items.length ? String(items.length) : "";
    if (!items.length) {
      box.innerHTML = '<p class="empty-line">아직 남긴 메모가 없어요. 마음에 남은 쪽을 찍어 보세요.</p>';
      return;
    }
    box.innerHTML = html`${raw(items.length > 1 ? sortButtons(bookSort) : "")}
      <ul class="note-list">${sortItems(items, bookSort).map((n) => raw(noteRow(n)))}</ul>`;
    box.querySelectorAll("[data-sort]").forEach((b) => b.addEventListener("click", () => { bookSort = b.dataset.sort; draw(); }));
  };
  draw();
}

// ── 기록 탭 ──────────────────────────────────────────────
const tab = { view: "notes", sort: "recent", shelf: "" };
export function resetNotes() { tab.view = "notes"; tab.sort = "recent"; tab.shelf = ""; bookSort = "recent"; }

export async function viewNotes(ctx) {
  const shell = (body) => ctx.mount(html`
    <main class="shell">
      <header class="topbar"><h1>기록</h1>${raw(ctx.meButton())}</header>
      ${raw(body)}
    </main>
    ${raw(ctx.tabbar("notes"))}`);
  shell('<p class="empty-line">불러오는 중…</p>');
  let notes;
  let marks;
  try {
    [{ items: notes }, { items: marks }] = await Promise.all([api.notes.list(), api.highlights.list()]);
  } catch (err) {
    if (ctx.isCurrent("notes")) shell(html`<p class="empty-line">${err.message}</p>`);
    return;
  }
  if (!ctx.isCurrent("notes")) return;

  const draw = () => {
    const books = new Map();
    for (const n of notes) if (n.book) books.set(n.shelf_id, n.book.title);
    if (tab.shelf && !books.has(tab.shelf)) tab.shelf = "";
    const pickShelf = (x) => !tab.shelf || x.shelf_id === tab.shelf;
    const shownNotes = sortItems(notes.filter(pickShelf), tab.sort);
    const shownMarks = sortItems(marks.filter(pickShelf), tab.sort);
    const list = tab.view === "notes" ? shownNotes : shownMarks;
    const empty = !notes.length
      ? html`<div class="soon"><h2>찍은 문장과 밑줄이 여기 모여요</h2><p>서재에서 책을 고른 뒤 [문장 찍기]나 [메모 쓰기]를 눌러 보세요.</p><p><a class="btn btn-primary" href="#/shelf">서재로 가기</a></p></div>`
      : html`<p class="empty-line">${tab.view === "notes" ? "이 책에 남긴 메모가 없어요." : "아직 그은 밑줄이 없어요. 메모를 열어 [밑줄 긋기]를 눌러 보세요."}</p>`;
    shell(html`
      <div class="segments" role="group" aria-label="보기">
        <button type="button" data-view="notes" aria-pressed="${tab.view === "notes"}">메모 ${shownNotes.length}</button>
        <button type="button" data-view="marks" aria-pressed="${tab.view === "marks"}">밑줄 ${shownMarks.length}</button>
      </div>
      ${raw(notes.length ? html`<div class="list-tools">
        <label class="select-wrap"><span class="visually-hidden">책 고르기</span>
          <select id="shelf-pick">
            <option value="">모든 책</option>
            ${[...books.entries()].sort((x, y) => x[1].localeCompare(y[1], "ko")).map(([id, t]) => raw(html`<option value="${id}" ${raw(id === tab.shelf ? "selected" : "")}>${t}</option>`))}
          </select></label>
        ${raw(sortButtons(tab.sort))}
      </div>` : "")}
      ${raw(list.length ? html`<ul class="${tab.view === "notes" ? "note-list" : "hl-list"}">${list.map((x) => raw(tab.view === "notes" ? noteRow(x, !tab.shelf) : highlightRow(x)))}</ul>` : empty)}`);
    ctx.app.querySelectorAll("[data-view]").forEach((b) => b.addEventListener("click", () => { tab.view = b.dataset.view; draw(); }));
    ctx.app.querySelectorAll("[data-sort]").forEach((b) => b.addEventListener("click", () => { tab.sort = b.dataset.sort; draw(); }));
    ctx.app.querySelector("#shelf-pick")?.addEventListener("change", (e) => { tab.shelf = e.target.value; draw(); });
  };
  draw();
}

// ── 메모 자세히 ───────────────────────────────────────────
export async function viewNote(ctx, id) {
  const route = `note/${id}`;
  const back = '<header class="topbar"><a class="back" href="#/notes">← 기록</a></header>';
  ctx.mount(`<main class="shell no-tabs">${back}<p class="empty-line">불러오는 중…</p></main>`);
  try {
    const { item } = await api.notes.get(id);
    if (ctx.isCurrent(route)) drawNote(ctx, item, route);
  } catch (err) {
    if (!ctx.isCurrent(route)) return;
    ctx.mount(html`<main class="shell no-tabs">${raw(back)}<p class="empty-line">${err.message}</p></main>`);
  }
}

function drawNote(ctx, note, route) {
  const title = note.book?.title || "책";
  const meta = [note.page !== null && note.page !== undefined ? `${note.page}쪽` : "", KIND[note.kind], formatDate(note.created_at)].filter(Boolean).join(" · ");
  const marked = markedBody(note.body || "", note.highlights);
  ctx.mount(html`
    <main class="shell no-tabs">
      <header class="topbar"><a class="back" href="#/book/${note.shelf_id}">← ${title}</a></header>
      <p class="note-meta note-meta-top">${meta}</p>
      <article class="note-body ${note.kind === "thought" ? "is-thought" : ""}" id="note-body">${raw(note.body ? marked.html : '<span class="empty-inline">글자 없이 사진만 남긴 메모예요.</span>')}</article>
      <div id="picker-wrap" hidden>
        <p class="pick-help" id="pick-help" role="status">밑줄 시작 단어를 누르세요.</p>
        <div class="reader" id="picker"></div>
        <div class="row-actions">
          <button class="btn btn-primary" type="button" id="hl-save" disabled>밑줄 저장</button>
          <button class="btn btn-quiet" type="button" id="hl-done">끝내기</button>
        </div>
      </div>
      ${raw(note.thought ? html`<blockquote class="note-thought-full"><span>내 생각</span>${note.thought}</blockquote>` : "")}
      ${raw(note.has_photo ? html`<section class="block photo-block">
        <h2>남긴 사진</h2>
        <button class="btn btn-quiet" type="button" id="show-photo">사진 보기</button>
        <figure class="kept-photo" id="kept-photo" hidden><img alt="${title} ${meta} 사진" referrerpolicy="no-referrer"></figure>
      </section>` : "")}
      <section class="block">
        <h2>밑줄 <span class="count">${note.highlights.length || ""}</span></h2>
        ${raw(note.highlights.length ? html`<ul class="hl-list">${note.highlights.map((h) => raw(html`<li class="hl-item">
          <span class="hl-text">${h.text}</span>
          ${raw(marked.unplaced.includes(h) ? '<span class="note-meta">글을 고쳐서 본문에는 표시되지 않아요</span>' : "")}
          <button class="link-btn" type="button" data-hl-remove="${h.id}">지우기</button></li>`))}</ul>`
          : '<p class="empty-line">아직 그은 밑줄이 없어요.</p>')}
        ${raw(note.body ? '<button class="btn btn-quiet" type="button" id="hl-start">밑줄 긋기</button>' : "")}
      </section>
      <section class="block" id="edit-block">
        <h2>고치기</h2>
        <form class="form" id="edit" novalidate hidden>
          <div class="field"><label for="edit-body">${note.kind === "thought" ? "메모" : "찍은 문장"}</label>
            <textarea id="edit-body" rows="8">${note.body}</textarea></div>
          ${raw(ctx.field({ id: "edit-page", label: "쪽수 (선택)", inputmode: "numeric", value: note.page ?? "" }))}
          ${raw(note.kind === "capture" ? html`<div class="field"><label for="edit-thought">내 생각 한마디 (선택)</label><textarea id="edit-thought" rows="3">${note.thought ?? ""}</textarea></div>` : "")}
          <p class="form-error" role="alert"></p>
          <div class="row-actions">
            <button class="btn btn-primary" type="submit">고친 내용 저장</button>
            <button class="btn btn-quiet" type="button" id="edit-cancel">그만 고치기</button>
          </div>
        </form>
        <div class="row-actions" id="edit-open-row">
          <button class="btn btn-quiet" type="button" id="edit-open">글 · 쪽수 고치기</button>
          ${raw(note.has_photo && note.body ? '<button class="btn btn-warn" type="button" id="photo-remove">사진만 지우기</button>' : "")}
          <button class="btn btn-warn" type="button" id="remove">메모 지우기</button>
        </div>
      </section>
    </main>`);
  const $ = (s) => ctx.app.querySelector(s);
  const refresh = (item) => { if (ctx.isCurrent(route)) drawNote(ctx, item, route); };

  // 사진: 누를 때만 잠깐 열리는 주소를 받아 보여 줌
  $("#show-photo")?.addEventListener("click", (e) => busy(e.currentTarget, async () => {
    try {
      const { item } = await api.notes.get(note.id);
      if (!item.photo_url) { toast("사진을 불러오지 못했어요. 잠시 뒤 다시 해 주세요."); return; }
      const fig = $("#kept-photo");
      const img = fig.querySelector("img");
      img.addEventListener("error", () => toast("사진을 불러오지 못했어요. [사진 보기]를 다시 눌러 주세요."), { once: true });
      img.src = item.photo_url;
      fig.hidden = false;
      e.target.hidden = true;
    } catch (err) { toast(err.message); }
  }));

  // 밑줄 긋기
  let range = null;
  const pickHelp = $("#pick-help");
  const picker = note.body ? mountPicker($("#picker"), {
    getText: () => note.body,
    getRanges: () => placeHighlights(note.body, note.highlights).placed,
    onPick: (r, first) => {
      range = r;
      $("#hl-save").disabled = !r;
      pickHelp.textContent = r ? `「${preview(note.body.slice(r.start, r.end), 40)}」 — [밑줄 저장]을 누르세요.`
        : first ? `「${first}」부터 — 끝 단어를 누르세요.` : "밑줄 시작 단어를 누르세요.";
    },
  }) : null;
  $("#hl-start")?.addEventListener("click", () => {
    $("#picker-wrap").hidden = false;
    $("#note-body").hidden = true;
    $("#hl-start").hidden = true;
    picker.reset();
    $("#picker").querySelector("button.w")?.focus();
  });
  $("#hl-done")?.addEventListener("click", () => refresh(note));
  $("#hl-save")?.addEventListener("click", (e) => busy(e.currentTarget, async () => {
    if (!range) return;
    try {
      const { item } = await api.highlights.add(note.id, range.start, range.end);
      toast("밑줄을 저장했어요.");
      note.highlights = item.highlights;
      refresh(item);
      $("#hl-start")?.click();
    } catch (err) { toast(err.message); }
  }));
  ctx.app.querySelectorAll("[data-hl-remove]").forEach((b) => b.addEventListener("click", async () => {
    const ok = await confirmBox({ title: "밑줄을 지울까요?", body: "메모 글은 그대로 남아요.", ok: "지우기", danger: true });
    if (!ok) return;
    busy(b, async () => {
      try {
        await api.highlights.remove(b.dataset.hlRemove);
        const { item } = await api.notes.get(note.id);
        toast("밑줄을 지웠어요.");
        refresh(item);
      } catch (err) { toast(err.message); }
    });
  }));

  // 고치기
  const form = $("#edit");
  $("#edit-open").addEventListener("click", () => {
    form.hidden = false;
    $("#edit-open-row").hidden = true;
    form.querySelector("#edit-body").focus();
  });
  $("#edit-cancel").addEventListener("click", () => refresh(note));
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const pageRaw = form.querySelector("#edit-page").value.trim();
    const page = pageRaw === "" ? null : Number(pageRaw);
    if (page !== null && (!Number.isInteger(page) || page < 0 || page > 20000)) return ctx.showError(form, "쪽수는 0~20000 사이 숫자로 적어 주세요.", "edit-page");
    const fields = { body: form.querySelector("#edit-body").value, page };
    if (note.kind === "capture") fields.thought = form.querySelector("#edit-thought").value;
    busy(form.querySelector("[type=submit]"), async () => {
      try {
        const { item } = await api.notes.update(note.id, fields);
        toast("고친 내용을 저장했어요.");
        refresh(item);
      } catch (err) { ctx.showError(form, err.message); }
    });
  });

  $("#photo-remove")?.addEventListener("click", async (e) => {
    const ok = await confirmBox({ title: "사진만 지울까요?", body: "메모 글과 밑줄은 남고, 사진은 되돌릴 수 없어요.", ok: "사진 지우기", danger: true });
    if (!ok) return;
    busy(e.target, async () => {
      try { const { item } = await api.notes.removePhoto(note.id); toast("사진을 지웠어요."); refresh(item); }
      catch (err) { toast(err.message); }
    });
  });
  $("#remove").addEventListener("click", async (e) => {
    const ok = await confirmBox({ title: "메모를 지울까요?", body: `이 메모와 밑줄${note.has_photo ? ", 남긴 사진" : ""}이 함께 지워지고 되돌릴 수 없어요.`, ok: "지우기", danger: true });
    if (!ok) return;
    busy(e.target, async () => {
      try { await api.notes.remove(note.id); toast("메모를 지웠어요."); ctx.go(`book/${note.shelf_id}`); }
      catch (err) { toast(err.message); }
    });
  });
}

// ── 내 생각 쓰기 ─────────────────────────────────────────
export async function viewWrite(ctx, shelfId) {
  const route = `write/${shelfId}`;
  let book = null;
  try { ({ item: { book } } = await api.shelf.get(shelfId)); }
  catch (err) {
    if (ctx.isCurrent(route)) ctx.mount(html`<main class="shell no-tabs"><header class="topbar"><a class="back" href="#/shelf">← 서재</a></header><p class="empty-line">${err.message}</p></main>`);
    return;
  }
  if (!ctx.isCurrent(route)) return;
  ctx.mount(html`
    <main class="shell no-tabs">
      <header class="topbar"><a class="back" href="#/book/${shelfId}">← ${book.title}</a></header>
      <h1 class="who">메모 쓰기</h1>
      <form class="form" id="write" novalidate>
        <div class="field"><label for="write-body">떠오른 생각</label>
          <textarea id="write-body" rows="9" maxlength="20000"></textarea></div>
        ${raw(ctx.field({ id: "write-page", label: "쪽수 (선택)", inputmode: "numeric" }))}
        <p class="form-error" role="alert"></p>
        <button class="btn btn-primary btn-block" type="submit">메모 저장</button>
      </form>
    </main>`);
  const form = ctx.app.querySelector("#write");
  form.querySelector("#write-body").focus();
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const body = form.querySelector("#write-body").value;
    if (!body.trim()) return ctx.showError(form, "메모 내용을 적어 주세요.", "write-body");
    const pageRaw = form.querySelector("#write-page").value.trim();
    const page = pageRaw === "" ? null : Number(pageRaw);
    if (page !== null && (!Number.isInteger(page) || page < 0 || page > 20000)) return ctx.showError(form, "쪽수는 0~20000 사이 숫자로 적어 주세요.", "write-page");
    busy(form.querySelector("[type=submit]"), async () => {
      try {
        await api.notes.add({ shelf_id: shelfId, kind: "thought", body, page });
        toast("메모를 저장했어요.");
        ctx.go(`book/${shelfId}`);
      } catch (err) { ctx.showError(form, err.message); }
    });
  });
}
