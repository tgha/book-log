// book-log 2단계 화면: 서재 목록 · 책 등록(제목 검색 · 바코드 · 직접 입력) · 책 자세히
import { api } from "./api.js";
import { markFromBook } from "./capture.js";
import { mountBookNotes } from "./notes.js";
import { minutesText, mountBookLogs, mountRunningBanner, startTimer } from "./reading.js";
import { busy, confirmBox, html, raw, toast } from "./ui.js";

const STATUS = { reading: "읽는 중", want: "읽고 싶은", finished: "다 읽음", stopped: "그만 읽음" };
const ORDER = ["reading", "want", "finished", "stopped"];

let shelfCache = null; // 서재 목록 (화면을 오갈 때 깜빡임 줄이기)
let shelfFilter = "want";
let picked = null; // 확인 화면으로 넘길 책
let search = { query: "", books: [], page: 1, isEnd: true };
let scanStop = null;

export function stopScanner() {
  if (scanStop) { scanStop(); scanStop = null; }
}
export function resetBooks() {
  shelfCache = null; picked = null; shelfFilter = "want";
  search = { query: "", books: [], page: 1, isEnd: true };
}

// ── 작은 도우미 ──────────────────────────────────────────
function isbnOk(s) {
  if (!/^97[89]\d{10}$/.test(s)) return false;
  const d = s.split("").map(Number);
  const sum = d.slice(0, 12).reduce((a, n, i) => a + n * (i % 2 ? 3 : 1), 0);
  return (10 - (sum % 10)) % 10 === d[12];
}
const byline = (b) => {
  const a = (b.authors || []).join(", ");
  const t = (b.translators || []).length ? ` · ${(b.translators || []).join(", ")} 옮김` : "";
  return a + t;
};
const publine = (b) => [b.publisher, b.published_on ? b.published_on.slice(0, 4) : ""].filter(Boolean).join(" · ");

function cover(b, size = "") {
  return b && b.cover_url
    ? html`<img class="cover ${size}" src="${b.cover_url}" alt="" loading="lazy" referrerpolicy="no-referrer" data-title="${b.title}">`
    : html`<span class="cover cover-blank ${size}" aria-hidden="true"><span>${(b && b.title || "").slice(0, 14)}</span></span>`;
}

/** 표지가 안 불러와지면 글자 표지로, 진행 막대 길이 맞추기 (보안 규칙상 style 속성 대신 여기서 처리) */
function decorate(root) {
  root.querySelectorAll("img.cover").forEach((img) => img.addEventListener("error", () => {
    const s = document.createElement("span");
    s.className = img.className.replace("cover ", "cover cover-blank ");
    s.setAttribute("aria-hidden", "true");
    const t = document.createElement("span");
    t.textContent = (img.dataset.title || "").slice(0, 14);
    s.append(t);
    img.replaceWith(s);
  }, { once: true }));
  root.querySelectorAll(".bar[data-pct]").forEach((el) => { el.style.width = `${el.dataset.pct}%`; });
}

function progress(item) {
  if (!item.total_pages || item.current_page === null || item.current_page === undefined) return "";
  const pct = Math.min(100, Math.round((item.current_page / item.total_pages) * 100));
  return html`<span class="progress" role="img" aria-label="${pct}퍼센트 읽음"><span class="bar" data-pct="${pct}"></span></span>
    <span class="book-by">${item.current_page} / ${item.total_pages}쪽 · ${pct}%</span>`;
}

function shelfRow(item, quick = false) {
  const b = item.book || {};
  return html`<li><a class="book-row" href="#/book/${item.id}">${raw(cover(b))}
    <span class="book-text"><span class="book-title">${b.title}</span><span class="book-by">${byline(b)}</span>${raw(progress(item))}</span></a>
    ${raw(quick ? html`<div class="row-quick">
      <button class="btn btn-quiet btn-small" type="button" data-start-timer="${item.id}">독서 시작</button>
      <a class="btn btn-quiet btn-small" href="#/capture/${item.id}/camera" data-start-capture>문장 찍기</a>
    </div>` : "")}</li>`;
}

function statusChips(name, current, list = ORDER) {
  return html`<fieldset class="chips"><legend>${name}</legend>${list.map((s) => raw(html`
    <label class="chip"><input type="radio" name="status" value="${s}" ${raw(s === current ? "checked" : "")}><span>${STATUS[s]}</span></label>`))}
  </fieldset>`;
}

function readPages(form, name, label) {
  const v = form[name].value.trim();
  if (!v) return { value: null };
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > 20000) return { error: `${label}는 0~20000 사이 숫자로 적어 주세요.` };
  return { value: n };
}

// ── 서재 ─────────────────────────────────────────────────
export async function viewShelf(ctx) {
  const u = ctx.state.user;
  const draw = (items, loading, error = "") => {
    const counts = Object.fromEntries(ORDER.map((s) => [s, items.filter((i) => i.status === s).length]));
    const reading = items.filter((i) => i.status === "reading");
    const others = items.filter((i) => i.status === shelfFilter);
    const readingBody = error ? html`<p class="empty-line">${error}</p>`
      : loading ? '<p class="empty-line">불러오는 중…</p>'
      : reading.length ? html`<ul class="book-list">${reading.map((i) => raw(shelfRow(i, true)))}</ul>`
      : '<p class="empty-line">읽고 있는 책이 없어요. 아래 단추로 책을 등록해 보세요.</p>';
    ctx.mount(html`
      <main class="shell">
        <header class="topbar"><h1>${u.display_name}님의 서재</h1>${raw(ctx.meButton())}</header>
        ${raw(ctx.pendingNote())}
        <div id="running-slot"></div>
        <section class="streak" aria-label="이어서 읽은 날">
          <span class="ribbon" aria-hidden="true"></span>
          <p class="days" id="streak-days">·<small>일째</small></p>
          <p class="what">이어서 읽은 날</p>
          <p class="note" id="streak-note">독서 시간을 적은 날부터 하루씩 셉니다.</p>
        </section>
        <a class="btn btn-primary btn-block" href="#/add">＋ 책 등록하기</a>
        <section class="shelf-section" aria-labelledby="reading-title">
          <h2 class="section-title" id="reading-title">읽고 있는 책 <span class="count">${counts.reading}</span></h2>
          ${raw(readingBody)}
        </section>
        <section class="shelf-section" aria-label="다른 책">
          <div class="segments" role="group" aria-label="상태별로 보기">${["want", "finished", "stopped"].map((s) => raw(html`
            <button data-filter="${s}" aria-pressed="${shelfFilter === s}">${STATUS[s]} ${counts[s]}</button>`))}
          </div>
          ${raw(loading || error ? "" : others.length ? html`<ul class="book-list">${others.map((i) => raw(shelfRow(i)))}</ul>`
            : html`<p class="empty-line">${STATUS[shelfFilter]} 책이 없어요.</p>`)}
        </section>
        ${raw(ctx.installBlock())}
      </main>
      ${raw(ctx.tabbar("shelf"))}`);
    decorate(ctx.app);
    mountRunningBanner(ctx, ctx.app.querySelector("#running-slot"));
    ctx.app.querySelectorAll("[data-start-timer]").forEach((b) => b.addEventListener("click", (e) => startTimer(ctx, b.dataset.startTimer, e.currentTarget)));
    api.stats.streak().then((r) => {
      if (!ctx.isCurrent("shelf")) return;
      const days = ctx.app.querySelector("#streak-days");
      if (!days) return;
      days.innerHTML = html`${r.streak}<small>일째</small>`;
      ctx.app.querySelector("#streak-note").textContent = r.today_minutes
        ? `오늘 ${minutesText(r.today_minutes)} 읽었어요 · 가장 길었던 기록 ${r.best_streak}일`
        : r.best_streak ? `오늘은 아직이에요 · 가장 길었던 기록 ${r.best_streak}일` : "독서 시간을 적은 날부터 하루씩 셉니다.";
    }).catch(() => { const d = ctx.app.querySelector("#streak-days"); if (d) d.innerHTML = html`0<small>일째</small>`; });
    ctx.app.querySelectorAll("[data-filter]").forEach((b) => b.addEventListener("click", () => {
      shelfFilter = b.dataset.filter;
      draw(shelfCache || [], false);
    }));
    ctx.afterShelfMount();
  };
  draw(shelfCache || [], !shelfCache);
  try {
    const { items } = await api.shelf.list();
    shelfCache = items;
    if (ctx.isCurrent("shelf")) draw(items, false);
  } catch (err) {
    if (ctx.isCurrent("shelf")) draw(shelfCache || [], false, err.message);
  }
}

// ── 책 등록: 첫 화면 (제목 검색) ─────────────────────────
function resultRow(b, i) {
  return html`<li><button type="button" class="book-row" data-pick="${i}">${raw(cover(b))}
    <span class="book-text"><span class="book-title">${b.title}</span><span class="book-by">${byline(b)}</span>
    <span class="book-by">${publine(b)}</span>${raw(b.shelf_id ? '<span class="tag">내 서재에 있음</span>' : "")}</span></button></li>`;
}

function pick(ctx, b) {
  if (b.shelf_id) { toast("이미 내 서재에 있는 책이에요."); ctx.go(`book/${b.shelf_id}`); return; }
  picked = b;
  ctx.go("add-confirm");
}

export function viewAdd(ctx) {
  ctx.mount(html`
    <main class="shell no-tabs">
      <header class="topbar"><button class="back" data-go="shelf">← 서재</button></header>
      <h1 class="who">책 등록하기</h1>
      <div class="add-ways">
        <a class="way" href="#/scan"><strong>바코드 찍기</strong><span>책 뒷면 바코드를 비추면 바로 찾아요</span></a>
        <a class="way" href="#/add-manual"><strong>직접 입력하기</strong><span>검색에 없는 책은 손으로 적어요</span></a>
      </div>
      <form class="form" id="find" role="search" novalidate>
        <div class="field">
          <label for="q">제목이나 저자로 찾기</label>
          <div class="inline-form">
            <div class="input-wrap grow"><input id="q" name="q" type="search" value="${search.query}" enterkeyhint="search" autocomplete="off"></div>
            <button class="btn btn-primary" type="submit">찾기</button>
          </div>
        </div>
        <p class="form-error" role="alert"></p>
      </form>
      <ul class="book-list" id="results"></ul>
      <div id="more"></div>
    </main>`);
  const form = ctx.app.querySelector("#find");
  const list = ctx.app.querySelector("#results");
  const more = ctx.app.querySelector("#more");

  const show = () => {
    if (!search.query) { list.innerHTML = ""; more.innerHTML = ""; return; }
    list.innerHTML = search.books.length ? search.books.map((b, i) => resultRow(b, i)).join("")
      : html`<li><p class="empty-line">「${search.query}」에 맞는 책이 없어요. <a href="#/add-manual">직접 입력하기</a></p></li>`;
    more.innerHTML = search.isEnd ? "" : '<button class="btn btn-quiet btn-block" type="button" id="more-btn">더 보기</button>';
    decorate(list);
    list.querySelectorAll("[data-pick]").forEach((btn) => btn.addEventListener("click", () => pick(ctx, search.books[Number(btn.dataset.pick)])));
    more.querySelector("#more-btn")?.addEventListener("click", (e) => busy(e.currentTarget, async () => {
      try {
        const r = await api.book.search(search.query, search.page + 1);
        search = { ...search, books: search.books.concat(r.books), page: r.page, isEnd: r.is_end };
        show();
      } catch (err) { toast(err.message); }
    }));
  };
  show();
  if (!search.query) form.q.focus();

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const q = form.q.value.trim();
    if (!q) return ctx.showError(form, "찾을 책 제목이나 저자를 적어 주세요.", "q");
    form.q.blur();
    busy(form.querySelector("[type=submit]"), async () => {
      try {
        const r = await api.book.search(q, 1);
        ctx.showError(form, "");
        search = { query: q, books: r.books, page: 1, isEnd: r.is_end };
        show();
      } catch (err) { ctx.showError(form, err.message); }
    });
  });
}

// ── 책 등록: 바코드 ──────────────────────────────────────
export async function viewScan(ctx) {
  ctx.mount(html`
    <main class="shell no-tabs">
      <header class="topbar"><button class="back" data-go="add">← 책 등록</button></header>
      <h1 class="who">바코드 찍기</h1>
      <div class="scanner" id="scanner" hidden>
        <video id="cam" playsinline muted></video>
        <span class="scan-frame" aria-hidden="true"></span>
        <button class="torch" type="button" id="torch" hidden aria-pressed="false">손전등</button>
      </div>
      <p class="scan-help" id="scan-help" role="status">카메라를 켜는 중…</p>
      <button class="btn btn-quiet" type="button" id="rescan" hidden>다시 찍기</button>
      <form class="form" id="isbn-form" novalidate>
        ${raw(ctx.field({ id: "isbn", label: "또는 바코드 아래 숫자 13자리로 찾기", inputmode: "numeric", hint: "978 또는 979로 시작해요" }))}
        <p class="form-error" role="alert"></p>
        <button class="btn btn-quiet" type="submit">이 번호로 찾기</button>
      </form>
    </main>`);
  const form = ctx.app.querySelector("#isbn-form");
  const help = ctx.app.querySelector("#scan-help");
  const rescan = ctx.app.querySelector("#rescan");
  rescan.addEventListener("click", () => viewScan(ctx));

  const lookup = async (code) => {
    try {
      const { books } = await api.book.isbn(code);
      if (ctx.isCurrent("scan")) pick(ctx, books[0]);
    } catch (err) {
      ctx.showError(form, err.message);
      help.textContent = "책을 찾지 못했어요.";
      rescan.hidden = false;
    }
  };

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const code = form.isbn.value.replace(/[^0-9]/g, "");
    if (!isbnOk(code)) return ctx.showError(form, "13자리 숫자가 맞지 않아요. 978 또는 979로 시작하는지 확인해 주세요.", "isbn");
    stopScanner();
    busy(form.querySelector("[type=submit]"), () => lookup(code));
  });

  const unsupported = (msg) => { help.textContent = msg; };
  if (!("BarcodeDetector" in window) || !navigator.mediaDevices?.getUserMedia) {
    return unsupported("이 기기의 브라우저는 바코드 찍기를 지원하지 않아요. 바코드 아래 숫자를 적어 주세요.");
  }
  try {
    const formats = await window.BarcodeDetector.getSupportedFormats();
    if (!formats.includes("ean_13")) throw new Error("no ean_13");
  } catch {
    return unsupported("이 기기에서는 바코드 찍기가 안 돼요. 바코드 아래 숫자를 적어 주세요.");
  }
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } },
      audio: false,
    });
  } catch (e) {
    return unsupported(e && e.name === "NotAllowedError"
      ? "카메라 사용이 막혀 있어요. 크롬 주소창 왼쪽 아이콘 → 권한에서 카메라를 허용한 뒤 [다시 찍기]를 눌러 주세요."
      : "카메라를 켤 수 없어요. 바코드 아래 숫자를 적어 주세요.");
  }
  if (!ctx.isCurrent("scan")) { stream.getTracks().forEach((t) => t.stop()); return; }
  let alive = true;
  scanStop = () => { alive = false; stream.getTracks().forEach((t) => t.stop()); };
  // 자동 초점 · 약간 확대 (폰이 지원할 때만). 가까이 대지 않아도 바코드가 크고 또렷하게 찍히게 함
  const track = stream.getVideoTracks()[0];
  const caps = track && track.getCapabilities ? track.getCapabilities() : {};
  const adv = {};
  if (caps.focusMode && caps.focusMode.includes("continuous")) adv.focusMode = "continuous";
  if (caps.zoom && caps.zoom.max >= 1.5) adv.zoom = Math.min(2, caps.zoom.max);
  if (Object.keys(adv).length) { try { await track.applyConstraints({ advanced: [adv] }); } catch { /* 지원 안 하면 그대로 */ } }
  if (caps.torch) {
    const torch = ctx.app.querySelector("#torch");
    torch.hidden = false;
    torch.addEventListener("click", async () => {
      const on = torch.getAttribute("aria-pressed") !== "true";
      try { await track.applyConstraints({ advanced: [{ torch: on }] }); torch.setAttribute("aria-pressed", String(on)); } catch { /* 무시 */ }
    });
  }
  const video = ctx.app.querySelector("#cam");
  video.srcObject = stream;
  ctx.app.querySelector("#scanner").hidden = false;
  try { await video.play(); } catch { /* 자동 재생 막힘은 무시 */ }
  help.textContent = "바코드가 노란 네모에 가득 차게, 흔들리지 않게 비춰 주세요. 어두우면 손전등을 켜세요.";
  const detector = new window.BarcodeDetector({ formats: ["ean_13"] });
  const tick = async () => {
    if (!alive) return;
    try {
      const codes = await detector.detect(video);
      const hit = codes.map((c) => c.rawValue).find(isbnOk);
      if (hit) {
        stopScanner();
        if (navigator.vibrate) navigator.vibrate(60);
        form.isbn.value = hit;
        help.textContent = `${hit} — 책을 찾는 중…`;
        await lookup(hit);
        return;
      }
    } catch { /* 한 장면 인식 실패는 넘어감 */ }
    setTimeout(tick, 120);
  };
  tick();
}

// ── 책 등록: 확인 ────────────────────────────────────────
async function addToShelf(ctx, form, body) {
  await busy(form.querySelector("[type=submit]"), async () => {
    try {
      const { item } = await api.shelf.add(body);
      shelfCache = null;
      picked = null;
      search = { ...search, books: search.books.map((b) => (b.isbn13 && b.isbn13 === item.book.isbn13 ? { ...b, shelf_id: item.id } : b)) };
      toast("서재에 넣었어요.");
      ctx.go(`book/${item.id}`);
    } catch (err) {
      if (err.code && err.code.startsWith("ALREADY:")) {
        toast(err.message);
        ctx.go(`book/${err.code.slice(8)}`);
      } else ctx.showError(form, err.message);
    }
  });
}

export function viewConfirm(ctx) {
  if (!picked) return ctx.go("add");
  const b = picked;
  ctx.mount(html`
    <main class="shell no-tabs">
      <header class="topbar"><button class="back" data-go="add">← 책 등록</button></header>
      <div class="book-head">${raw(cover(b, "cover-lg"))}
        <div><h1 class="book-h1">${b.title}</h1><p class="book-by">${byline(b)}</p><p class="book-by">${publine(b)}</p>
        ${raw(b.isbn13 ? html`<p class="book-by">ISBN ${b.isbn13}</p>` : "")}</div>
      </div>
      ${raw(b.description ? html`<p class="book-desc">${b.description}</p>` : "")}
      <form class="form" id="add" novalidate>
        ${raw(statusChips("지금 이 책은", "reading", ["reading", "want", "finished"]))}
        ${raw(ctx.field({ id: "total_pages", label: "전체 쪽수 (선택)", inputmode: "numeric", hint: "적어 두면 얼마나 읽었는지 보여 드려요" }))}
        <p class="form-error" role="alert"></p>
        <button class="btn btn-primary btn-block" type="submit">서재에 넣기</button>
      </form>
    </main>`);
  decorate(ctx.app);
  const form = ctx.app.querySelector("#add");
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const p = readPages(form, "total_pages", "전체 쪽수");
    if (p.error || p.value === 0) return ctx.showError(form, p.error || "전체 쪽수는 1 이상으로 적어 주세요.", "total_pages");
    const status = form.querySelector("input[name=status]:checked").value;
    const body = b.isbn13
      ? { isbn: b.isbn13, status, total_pages: p.value }
      : { manual: { title: b.title, authors: (b.authors || []).join(", "), publisher: b.publisher || "" }, status, total_pages: p.value };
    addToShelf(ctx, form, body);
  });
}

// ── 책 등록: 직접 입력 ───────────────────────────────────
export function viewManual(ctx) {
  ctx.mount(html`
    <main class="shell no-tabs">
      <header class="topbar"><button class="back" data-go="add">← 책 등록</button></header>
      <h1 class="who">직접 입력하기</h1>
      <form class="form" id="manual" novalidate>
        ${raw(ctx.field({ id: "book_title", label: "제목" }))}
        ${raw(ctx.field({ id: "authors", label: "저자 (선택)", hint: "여러 명이면 쉼표(,)로 나눠 주세요" }))}
        ${raw(ctx.field({ id: "publisher", label: "출판사 (선택)" }))}
        ${raw(ctx.field({ id: "isbn", label: "ISBN 13자리 (선택)", inputmode: "numeric" }))}
        ${raw(ctx.field({ id: "total_pages", label: "전체 쪽수 (선택)", inputmode: "numeric" }))}
        ${raw(statusChips("지금 이 책은", "reading", ["reading", "want", "finished"]))}
        <p class="form-error" role="alert"></p>
        <button class="btn btn-primary btn-block" type="submit">서재에 넣기</button>
      </form>
    </main>`);
  const form = ctx.app.querySelector("#manual");
  form.book_title.focus();
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const title = form.book_title.value.trim();
    if (!title) return ctx.showError(form, "책 제목을 적어 주세요.", "book_title");
    const isbn = form.isbn.value.replace(/[^0-9]/g, "");
    if (isbn && !isbnOk(isbn)) return ctx.showError(form, "ISBN은 978 또는 979로 시작하는 13자리 숫자예요. 모르면 비워 두세요.", "isbn");
    const p = readPages(form, "total_pages", "전체 쪽수");
    if (p.error || p.value === 0) return ctx.showError(form, p.error || "전체 쪽수는 1 이상으로 적어 주세요.", "total_pages");
    addToShelf(ctx, form, {
      manual: { title, authors: form.authors.value, publisher: form.publisher.value, isbn },
      status: form.querySelector("input[name=status]:checked").value,
      total_pages: p.value,
    });
  });
}

// ── 책 자세히 ────────────────────────────────────────────
export async function viewBook(ctx, id) {
  const route = `book/${id}`;
  ctx.mount('<main class="shell no-tabs"><header class="topbar"><button class="back" data-go="shelf">← 서재</button></header><p class="empty-line">불러오는 중…</p></main>');
  try {
    const { item } = await api.shelf.get(id);
    if (ctx.isCurrent(route)) drawBook(ctx, item);
  } catch (err) {
    if (!ctx.isCurrent(route)) return;
    ctx.mount(html`<main class="shell no-tabs"><header class="topbar"><button class="back" data-go="shelf">← 서재</button></header>
      <p class="empty-line">${err.message}</p></main>`);
  }
}

function drawBook(ctx, item) {
  const b = item.book || {};
  ctx.mount(html`
    <main class="shell no-tabs">
      <header class="topbar"><button class="back" data-go="shelf">← 서재</button></header>
      <div class="book-head">${raw(cover(b, "cover-lg"))}
        <div><h1 class="book-h1">${b.title}</h1><p class="book-by">${byline(b)}</p><p class="book-by">${publine(b)}</p></div>
      </div>
      <form id="status-form">${raw(statusChips("상태", item.status))}</form>
      <section class="block" id="logs-block"></section>
      <section class="block" id="public-block">
        <h2>공개</h2>
        <div class="switch-row">
          <label class="switch"><input type="checkbox" role="switch" id="is-public" ${raw(item.is_public ? "checked" : "")}><span class="switch-track" aria-hidden="true"></span><span>이 책 공개하기</span></label>
          <p class="hint">켜면 승인된 회원이 [둘러보기]에서 이 책의 기록(독서 시간 · 문장 · 사진 · 내 생각) 전체를 볼 수 있어요. 끄면 바로 안 보여요.</p>
        </div>
      </section>
      <section class="block" id="notes-block"></section>
      <section class="block">
        <h2>얼마나 읽었나요</h2>
        ${raw(progress(item))}
        <form class="form" id="pages" novalidate>
          <div class="pair">
            ${raw(ctx.field({ id: "current_page", label: "읽은 쪽", inputmode: "numeric", value: item.current_page ?? "" }))}
            ${raw(ctx.field({ id: "total_pages", label: "전체 쪽수", inputmode: "numeric", value: item.total_pages ?? "" }))}
          </div>
          <p class="form-error" role="alert"></p>
          <button class="btn btn-quiet" type="submit">쪽수 저장</button>
        </form>
      </section>
      <section class="block">
        <h2>날짜</h2>
        <form class="form" id="dates" novalidate>
          <div class="pair">
            ${raw(ctx.field({ id: "started_on", label: "시작한 날", type: "date", value: item.started_on ?? "" }))}
            ${raw(ctx.field({ id: "finished_on", label: "다 읽은 날", type: "date", value: item.finished_on ?? "" }))}
          </div>
          <p class="form-error" role="alert"></p>
          <button class="btn btn-quiet" type="submit">날짜 저장</button>
        </form>
      </section>

      ${raw(b.description ? html`<section class="block"><h2>책 소개</h2><p class="book-desc">${b.description}</p></section>` : "")}
      <section class="block">
        <button class="btn btn-warn" type="button" id="remove">서재에서 빼기</button>
      </section>
    </main>`);
  decorate(ctx.app);
  const notesBlock = ctx.app.querySelector("#notes-block");
  notesBlock.addEventListener("click", (e) => { if (e.target.closest("[data-start-capture]")) markFromBook(item.id); });
  mountBookNotes(ctx, notesBlock, item.id);
  mountBookLogs(ctx, ctx.app.querySelector("#logs-block"), item);
  ctx.app.querySelector("#is-public").addEventListener("change", async (e) => {
    const on = e.target.checked;
    e.target.disabled = true;
    try {
      const r = await api.shelf.update(item.id, { is_public: on });
      item.is_public = r.item.is_public;
      toast(on ? "이 책을 공개했어요." : "공개를 껐어요.");
    } catch (err) { e.target.checked = !on; toast(err.message); } finally { e.target.disabled = false; }
  });

  const save = async (fields, form, button) => {
    const work = async () => {
      try {
        const { item: next } = await api.shelf.update(item.id, fields);
        shelfCache = null;
        drawBook(ctx, next);
        toast("저장했어요.");
      } catch (err) {
        if (form) ctx.showError(form, err.message);
        else { toast(err.message); drawBook(ctx, item); }
      }
    };
    return button ? busy(button, work) : work();
  };

  ctx.app.querySelectorAll("#status-form input[name=status]").forEach((r) =>
    r.addEventListener("change", () => save({ status: r.value })));

  const pagesForm = ctx.app.querySelector("#pages");
  pagesForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const c = readPages(pagesForm, "current_page", "읽은 쪽수");
    const t = readPages(pagesForm, "total_pages", "전체 쪽수");
    if (c.error) return ctx.showError(pagesForm, c.error, "current_page");
    if (t.error || t.value === 0) return ctx.showError(pagesForm, t.error || "전체 쪽수는 1 이상으로 적어 주세요.", "total_pages");
    if (c.value !== null && t.value !== null && c.value > t.value) return ctx.showError(pagesForm, "읽은 쪽수가 전체 쪽수보다 많아요.", "current_page");
    save({ current_page: c.value, total_pages: t.value }, pagesForm, pagesForm.querySelector("[type=submit]"));
  });

  const datesForm = ctx.app.querySelector("#dates");
  datesForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const s = datesForm.started_on.value || null;
    const f = datesForm.finished_on.value || null;
    if (s && f && f < s) return ctx.showError(datesForm, "다 읽은 날이 시작한 날보다 빨라요.", "finished_on");
    save({ started_on: s, finished_on: f }, datesForm, datesForm.querySelector("[type=submit]"));
  });

  ctx.app.querySelector("#remove").addEventListener("click", async (e) => {
    const ok = await confirmBox({
      title: "서재에서 뺄까요?",
      body: `「${b.title}」과 이 책에 남긴 기록(독서 시간·메모·사진)이 함께 지워지고, 되돌릴 수 없어요.`,
      ok: "빼기", danger: true,
    });
    if (!ok) return;
    busy(e.target, async () => {
      try {
        await api.shelf.remove(item.id);
        shelfCache = null;
        search = { ...search, books: search.books.map((x) => (x.shelf_id === item.id ? { ...x, shelf_id: null } : x)) };
        toast("서재에서 뺐어요.");
        ctx.go("shelf");
      } catch (err) { toast(err.message); }
    });
  });
}
