// book-log 메모 화면: 책 자세히의 메모 목록 · 기록 탭 · 메모 자세히 · 내 생각 쓰기 · 글자 모양 설정
// 문장 찍기 흐름은 capture.js
import { api } from "./api.js";
import { busy, confirmBox, formatDate, html, raw, toast } from "./ui.js";

// ── 글자 모양 (이 기기에 한 번 저장 → 메모 · 기록 · 문장 고르기에 모두 적용) ─────────
const READ_KEY = "bk_read";
export const READ_FONTS = [
  { id: "serif", label: "명조", css: "var(--serif)" },
  { id: "sans", label: "고딕", css: "var(--sans)" },
];
export const READ_SIZES = [
  { label: "작게", rem: 0.9375 },
  { label: "보통", rem: 1.0625 },
  { label: "조금 크게", rem: 1.1875 },
  { label: "크게", rem: 1.375 },
  { label: "아주 크게", rem: 1.625 },
];
export function readPrefs() {
  let p = {};
  try { p = JSON.parse(localStorage.getItem(READ_KEY) || "{}") || {}; } catch { /* 저장 불가 */ }
  const font = READ_FONTS.some((f) => f.id === p.font) ? p.font : "serif";
  const size = Number.isInteger(p.size) && p.size >= 0 && p.size < READ_SIZES.length ? p.size : 1;
  return { font, size };
}
export function applyReading(p = readPrefs()) {
  const root = document.documentElement.style;
  root.setProperty("--read-font", READ_FONTS.find((f) => f.id === p.font).css);
  root.setProperty("--read-size", `${READ_SIZES[p.size].rem}rem`);
}
export function saveReading(p) {
  try { localStorage.setItem(READ_KEY, JSON.stringify(p)); } catch { /* 저장 불가 */ }
  applyReading(p);
}
applyReading();

/** [나] 화면의 「글자 모양」 칸 */
export function readingSettingsHtml() {
  const p = readPrefs();
  return html`
    <fieldset class="chips" id="read-font"><legend>글꼴</legend>${READ_FONTS.map((f) => raw(html`
      <label class="chip"><input type="radio" name="read-font" value="${f.id}" ${raw(p.font === f.id ? "checked" : "")}><span class="font-${f.id}">${f.label}</span></label>`))}
    </fieldset>
    <fieldset class="chips" id="read-size"><legend>글자 크기</legend>${READ_SIZES.map((s, i) => raw(html`
      <label class="chip"><input type="radio" name="read-size" value="${i}" ${raw(p.size === i ? "checked" : "")}><span>${s.label}</span></label>`))}
    </fieldset>
    <p class="read-preview reading" aria-label="미리 보기">책을 덮고 나서도 오래 남는 문장이 있다. 그 문장을 적어 두는 곳.</p>
    <p class="hint">이 기기에 저장되고, 메모 · 기록 · 문장 고르기 화면에 모두 적용돼요.</p>`;
}
export function wireReadingSettings(root) {
  root.querySelectorAll("input[name=read-font], input[name=read-size]").forEach((r) => r.addEventListener("change", () => {
    const font = root.querySelector("input[name=read-font]:checked").value;
    const size = Number(root.querySelector("input[name=read-size]:checked").value);
    saveReading({ font, size });
  }));
}

// ── 목록 한 줄 ────────────────────────────────────────────
const KIND = { capture: "찍은 문장", thought: "내 생각" };

function noteMeta(n, withBook) {
  const bits = [];
  if (withBook && n.book) bits.push(n.book.title);
  if (n.page !== null && n.page !== undefined) bits.push(`${n.page}쪽`);
  bits.push(KIND[n.kind] || "메모");
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
    <span class="note-text reading">${text}</span>
    ${raw(n.thought ? html`<span class="note-thought">${preview(n.thought, 80)}</span>` : "")}
  </a></li>`;
}

// ── 정렬 (고른 것을 이 기기에 기억, 메모 · 사진 · 책 화면 공통) ─────────────
const SORT_KEY = "bk_sort";
const SORTS = [["new", "최신순"], ["old", "오래된순"], ["page", "쪽수순"], ["page_desc", "쪽수 역순"]];
function getSort() {
  try { const v = localStorage.getItem(SORT_KEY); return SORTS.some(([id]) => id === v) ? v : "new"; } catch { return "new"; }
}
function setSort(v) { try { localStorage.setItem(SORT_KEY, v); } catch { /* 저장 불가 */ } }

/** 최신순 · 오래된순 / 쪽수순 · 쪽수 역순(책 이름 → 쪽, 쪽 없는 것은 뒤로) */
function sortItems(items, sort) {
  const list = items.slice();
  const t = (x) => String(x.created_at);
  const title = (x, y) => (x.book?.title || "").localeCompare(y.book?.title || "", "ko");
  const noPage = (x) => (x.page === null || x.page === undefined ? 1 : 0);
  if (sort === "old") list.sort((x, y) => t(x).localeCompare(t(y)));
  else if (sort === "page") list.sort((x, y) => title(x, y) || noPage(x) - noPage(y) || (x.page ?? 0) - (y.page ?? 0) || t(x).localeCompare(t(y)));
  else if (sort === "page_desc") list.sort((x, y) => title(x, y) || noPage(x) - noPage(y) || (y.page ?? 0) - (x.page ?? 0) || t(y).localeCompare(t(x)));
  else list.sort((x, y) => t(y).localeCompare(t(x)));
  return list;
}

function sortSelect() {
  const cur = getSort();
  return html`<label class="select-wrap sort-wrap"><span class="visually-hidden">정렬</span>
    <select data-sort-select>${SORTS.map(([id, label]) => raw(html`<option value="${id}" ${raw(id === cur ? "selected" : "")}>${label}</option>`))}</select></label>`;
}
function wireSort(root, redraw) {
  root.querySelector("[data-sort-select]")?.addEventListener("change", (e) => { setSort(e.target.value); redraw(); });
}

// ── 책 자세히 안의 「메모」 ─────────────────────────────────
export async function mountBookNotes(ctx, root, shelfId) {
  const route = `book/${shelfId}`;
  root.innerHTML = html`
    <h2>메모 <span class="count" id="note-count"></span></h2>
    <div class="note-actions">
      <a class="btn btn-primary" href="#/capture/${shelfId}/camera" data-start-capture>문장 찍기</a>
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
      box.innerHTML = '<p class="empty-line">아직 남긴 메모가 없어요. 마음에 남은 문장을 찍어 보세요.</p>';
      return;
    }
    box.innerHTML = html`${raw(items.length > 1 ? html`<div class="list-tools">${raw(sortSelect())}</div>` : "")}
      <ul class="note-list">${sortItems(items, getSort()).map((n) => raw(noteRow(n)))}</ul>`;
    wireSort(box, draw);
  };
  draw();
}

// ── 사진 크게 보기 ────────────────────────────────────────
function openPhoto(p) {
  const dlg = document.getElementById("dialog");
  const cap = [p.book?.title, p.page !== null && p.page !== undefined ? `${p.page}쪽` : "", formatDate(p.created_at)].filter(Boolean).join(" · ");
  dlg.classList.add("photo-dialog");
  dlg.innerHTML = html`
    <figure class="viewer"><img src="${p.photo_url}" alt="${cap} 사진" referrerpolicy="no-referrer"><figcaption class="note-meta">${cap}</figcaption></figure>
    ${raw(p.preview ? html`<p class="viewer-text reading">${p.preview}</p>` : "")}
    <div class="actions">
      <a class="btn btn-quiet btn-small" href="#/note/${p.note_id}" data-go-note>메모 보기</a>
      <button class="btn btn-primary btn-small" type="button" data-close>닫기</button>
    </div>`;
  dlg.querySelector("[data-close]").addEventListener("click", () => dlg.close());
  dlg.querySelector("[data-go-note]").addEventListener("click", () => dlg.close());
  dlg.addEventListener("close", () => dlg.classList.remove("photo-dialog"), { once: true });
  dlg.showModal();
}

// ── 기록 탭: [메모] [사진] ───────────────────────────────────
const tab = { view: "notes", shelf: "" };
export function resetNotes() { tab.view = "notes"; tab.shelf = ""; }

export async function viewNotes(ctx) {
  const shell = (body) => ctx.mount(html`
    <main class="shell">
      <header class="topbar"><h1>기록</h1>${raw(ctx.meButton())}</header>
      ${raw(body)}
    </main>
    ${raw(ctx.tabbar("notes"))}`);
  shell('<p class="empty-line">불러오는 중…</p>');
  let notes;
  try {
    ({ items: notes } = await api.notes.list());
  } catch (err) {
    if (ctx.isCurrent("notes")) shell(html`<p class="empty-line">${err.message}</p>`);
    return;
  }
  if (!ctx.isCurrent("notes")) return;
  let photos = null;    // 사진 목록 (볼 때 받아 옴, 주소는 10분짜리라 8분 지나면 새로 받음)
  let photosAt = 0;
  let photoError = "";

  const draw = () => {
    if (!notes.length) {
      shell(html`<div class="soon"><h2>찍은 문장과 메모가 여기 모여요</h2><p>서재에서 책을 고른 뒤 [문장 찍기]나 [메모 쓰기]를 눌러 보세요.</p><p><a class="btn btn-primary" href="#/shelf">서재로 가기</a></p></div>`);
      return;
    }
    const books = new Map();
    for (const n of notes) if (n.book) books.set(n.shelf_id, n.book.title);
    if (tab.shelf && !books.has(tab.shelf)) tab.shelf = "";
    const mine = (x) => !tab.shelf || x.shelf_id === tab.shelf;
    const shownNotes = sortItems(notes.filter(mine), getSort());
    const photoCount = notes.filter((n) => n.has_photo && mine(n)).length;
    let body;
    if (tab.view === "photos") {
      if (photoError) body = html`<p class="empty-line">${photoError}</p>`;
      else if (!photos) body = '<p class="empty-line">사진을 불러오는 중…</p>';
      else {
        const shown = sortItems(photos.filter(mine), getSort());
        body = shown.length
          ? html`<ul class="photo-grid">${shown.map((p) => raw(html`<li><button type="button" class="photo-tile" data-note="${p.note_id}">
              ${raw(p.photo_url ? html`<img src="${p.photo_url}" alt="" loading="lazy" referrerpolicy="no-referrer">` : '<span class="photo-missing">사진을 불러오지 못했어요</span>')}
              <span class="photo-cap">${[tab.shelf ? "" : p.book?.title, p.page !== null && p.page !== undefined ? `${p.page}쪽` : ""].filter(Boolean).join(" · ") || formatDate(p.created_at)}</span>
            </button></li>`))}</ul>`
          : '<p class="empty-line">남긴 사진이 없어요. 문장을 저장할 때 [더 하기] → [사진도 남기기]를 켜면 여기 모여요.</p>';
      }
    } else {
      body = shownNotes.length ? html`<ul class="note-list">${shownNotes.map((x) => raw(noteRow(x, !tab.shelf)))}</ul>` : '<p class="empty-line">메모가 없어요.</p>';
    }
    shell(html`
      <div class="segments" role="group" aria-label="보기">
        <button type="button" data-view="notes" aria-pressed="${tab.view === "notes"}">메모 ${shownNotes.length}</button>
        <button type="button" data-view="photos" aria-pressed="${tab.view === "photos"}">사진 ${photoCount}</button>
      </div>
      <div class="list-tools">
        <label class="select-wrap"><span class="visually-hidden">책 고르기</span>
          <select id="shelf-pick">
            <option value="">모든 책</option>
            ${[...books.entries()].sort((x, y) => x[1].localeCompare(y[1], "ko")).map(([id, t]) => raw(html`<option value="${id}" ${raw(id === tab.shelf ? "selected" : "")}>${t}</option>`))}
          </select></label>
        ${raw(sortSelect())}
      </div>
      ${raw(body)}`);
    ctx.app.querySelectorAll("[data-view]").forEach((b) => b.addEventListener("click", () => { tab.view = b.dataset.view; draw(); loadPhotos(); }));
    ctx.app.querySelector("#shelf-pick").addEventListener("change", (e) => { tab.shelf = e.target.value; draw(); });
    wireSort(ctx.app, draw);
    ctx.app.querySelectorAll(".photo-tile").forEach((b) => b.addEventListener("click", () => {
      const p = photos.find((x) => x.note_id === b.dataset.note);
      if (p?.photo_url) openPhoto(p); else ctx.go(`note/${b.dataset.note}`);
    }));
    ctx.app.querySelectorAll(".photo-tile img").forEach((img) => img.addEventListener("error", () => {
      const s = document.createElement("span");
      s.className = "photo-missing";
      s.textContent = "사진을 불러오지 못했어요";
      img.replaceWith(s);
    }, { once: true }));
  };
  const loadPhotos = async () => {
    if (tab.view !== "photos" || (photos && Date.now() - photosAt < 8 * 60000)) return;
    photoError = "";
    try {
      ({ items: photos } = await api.photos.list());
      photosAt = Date.now();
    } catch (err) { photoError = err.message; }
    if (ctx.isCurrent("notes") && tab.view === "photos") draw();
  };
  draw();
  loadPhotos();
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
  ctx.mount(html`
    <main class="shell no-tabs">
      <header class="topbar"><a class="back" href="#/book/${note.shelf_id}">← ${title}</a></header>
      <p class="note-meta note-meta-top">${meta}</p>
      <article class="note-body reading" id="note-body">${raw(note.body ? html`${note.body}` : '<span class="empty-inline">글자 없이 사진만 남긴 메모예요.</span>')}</article>
      ${raw(note.thought ? html`<blockquote class="note-thought-full"><span>내 생각</span>${note.thought}</blockquote>` : "")}
      ${raw(note.has_photo ? html`<section class="block photo-block">
        <h2>남긴 사진</h2>
        <button class="btn btn-quiet" type="button" id="show-photo">사진 보기</button>
        <figure class="kept-photo" id="kept-photo" hidden><img alt="${title} ${meta} 사진" referrerpolicy="no-referrer"></figure>
      </section>` : "")}
      <section class="block" id="edit-block">
        <h2>고치기</h2>
        <form class="form" id="edit" novalidate hidden>
          <div class="field"><label for="edit-body">${note.kind === "thought" ? "메모" : "찍은 문장"}</label>
            <textarea id="edit-body" class="reading" rows="8">${note.body}</textarea></div>
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
    const ok = await confirmBox({ title: "사진만 지울까요?", body: "메모 글은 남고, 사진은 되돌릴 수 없어요.", ok: "사진 지우기", danger: true });
    if (!ok) return;
    busy(e.target, async () => {
      try { const { item } = await api.notes.removePhoto(note.id); toast("사진을 지웠어요."); refresh(item); }
      catch (err) { toast(err.message); }
    });
  });
  $("#remove").addEventListener("click", async (e) => {
    const ok = await confirmBox({ title: "메모를 지울까요?", body: `이 메모${note.has_photo ? "와 남긴 사진" : ""}이 지워지고 되돌릴 수 없어요.`, ok: "지우기", danger: true });
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
          <textarea id="write-body" class="reading" rows="9" maxlength="20000"></textarea></div>
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
