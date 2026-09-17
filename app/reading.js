// book-log 4단계 화면: 독서 시간 (타이머 · 손으로 적기 · 목록 · 고치기)
// · 시작 시각은 서버에 적는다 → 앱을 닫거나 화면이 꺼져도, PC 에서 열어도 이어서 보인다
// · 도서관에서 쓰므로 소리 · 진동은 넣지 않는다
import { api } from "./api.js";
import { busy, confirmBox, html, raw, toast } from "./ui.js";

let offset = 0;        // 서버 시각 - 이 기기 시각 (ms)
let ticks = [];        // 1초마다 도는 시계들 (화면을 떠나면 멈춤)
let cleanups = [];     // 화면을 떠날 때 할 일
let runningCache = null; // { item, at } 서재 알림용

export function stopReadingTimers() {
  ticks.forEach((t) => clearInterval(t));
  ticks = [];
  cleanups.forEach((f) => { try { f(); } catch { /* 무시 */ } });
  cleanups = [];
}
export function resetReading() { stopReadingTimers(); runningCache = null; }
const every = (fn) => { fn(); ticks.push(setInterval(fn, 1000)); };
const syncClock = (now) => { if (now) offset = Date.parse(now) - Date.now(); };
const serverNow = () => Date.now() + offset;
const pad = (n) => String(n).padStart(2, "0");
export function clock(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 3600)}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}`;
}
export function minutesText(m) {
  if (m < 60) return `${m}분`;
  return `${Math.floor(m / 60)}시간${m % 60 ? ` ${m % 60}분` : ""}`;
}
const kstToday = () => new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
const WEEK = ["일", "월", "화", "수", "목", "금", "토"];
export function dayText(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  const w = WEEK[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  return `${y !== Number(kstToday().slice(0, 4)) ? `${y}. ` : ""}${m}. ${d}. (${w})`;
}
function timeText(iso) {
  const d = new Date(iso);
  const h = d.getHours();
  return `${h < 12 ? "오전" : "오후"} ${h % 12 || 12}:${pad(d.getMinutes())}`;
}

async function loadRunning(force = false) {
  if (!force && runningCache && Date.now() - runningCache.at < 30000) return runningCache.item;
  const r = await api.logs.running();
  syncClock(r.now);
  runningCache = { item: r.item, at: Date.now() };
  return r.item;
}
const forgetRunning = () => { runningCache = null; };

/** 다른 책 타이머가 돌고 있을 때 */
async function askRunning(ctx, err) {
  const ok = await confirmBox({ title: "타이머가 이미 돌고 있어요", body: err.message, ok: "그 타이머 보기", cancel: "닫기" });
  if (ok) ctx.go("timer");
}

export async function startTimer(ctx, shelfId, button) {
  await busy(button, async () => {
    try {
      const r = await api.logs.start(shelfId);
      syncClock(r.now);
      runningCache = { item: r.item, at: Date.now() };
      ctx.go("timer");
    } catch (err) {
      if (err.code && err.code.startsWith("RUNNING:")) { forgetRunning(); askRunning(ctx, err); } else toast(err.message);
    }
  });
}

// ── 서재 위: 「읽는 중」 알림 ────────────────────────────────
export async function mountRunningBanner(ctx, root) {
  let item;
  try { item = await loadRunning(); } catch { return; }
  if (!item || !root.isConnected) { root.innerHTML = ""; return; }
  root.innerHTML = html`<a class="running-banner" href="#/timer">
    <span class="running-dot" aria-hidden="true"></span>
    <span class="running-title">「${item.shelf?.book?.title || "책"}」 읽는 중</span>
    <span class="running-clock" id="banner-clock">0:00:00</span></a>`;
  const el = root.querySelector("#banner-clock");
  const started = Date.parse(item.started_at);
  every(() => { if (el.isConnected) el.textContent = clock(serverNow() - started); });
}

// ── 책 자세히: 「독서 시간」 칸 ─────────────────────────────
export async function mountBookLogs(ctx, root, shelf) {
  const route = `book/${shelf.id}`;
  root.innerHTML = html`
    <h2>독서 시간 <span class="count" id="log-total"></span></h2>
    <div id="log-run"></div>
    <div class="note-actions" id="log-actions">
      <button class="btn btn-primary" type="button" id="log-start">독서 시작</button>
      <a class="btn btn-quiet" href="#/log/${shelf.id}">시간 적기</a>
    </div>
    <div id="log-list"><p class="empty-line">불러오는 중…</p></div>`;
  root.querySelector("#log-start").addEventListener("click", (e) => startTimer(ctx, shelf.id, e.currentTarget));
  let running;
  let list;
  try {
    [running, list] = await Promise.all([loadRunning(true), api.logs.list(shelf.id)]);
  } catch (err) {
    if (ctx.isCurrent(route)) root.querySelector("#log-list").innerHTML = html`<p class="empty-line">${err.message}</p>`;
    return;
  }
  if (!ctx.isCurrent(route) || !root.isConnected) return;
  if (running && running.shelf_id === shelf.id) {
    root.querySelector("#log-actions").hidden = true;
    root.querySelector("#log-run").innerHTML = html`<a class="running-banner" href="#/timer">
      <span class="running-dot" aria-hidden="true"></span><span class="running-title">읽는 중</span>
      <span class="running-clock" id="book-clock">0:00:00</span></a>`;
    const el = root.querySelector("#book-clock");
    const started = Date.parse(running.started_at);
    every(() => { if (el.isConnected) el.textContent = clock(serverNow() - started); });
  }
  root.querySelector("#log-total").textContent = list.items.length ? `모두 ${minutesText(list.total_minutes)}` : "";
  root.querySelector("#log-list").innerHTML = list.items.length
    ? html`<ul class="log-list">${list.items.map((x) => raw(html`<li><a class="log-row" href="#/log/${shelf.id}/${x.id}">
        <span class="log-day">${dayText(x.read_on)}</span>
        <span class="log-min">${minutesText(x.minutes)}</span>
        <span class="log-page">${x.end_page !== null && x.end_page !== undefined ? `${x.end_page}쪽까지` : ""}</span>
        <span class="log-how">${x.method === "timer" ? "타이머" : "적음"}</span></a></li>`))}</ul>`
    : '<p class="empty-line">아직 적은 독서 시간이 없어요. [독서 시작]을 누르면 시간을 재요.</p>';
}

// ── 타이머 화면 ─────────────────────────────────────────
export async function viewTimer(ctx) {
  ctx.mount('<main class="shell no-tabs"><p class="empty-line">불러오는 중…</p></main>');
  let item;
  try { item = await loadRunning(true); } catch (err) {
    if (ctx.isCurrent("timer")) ctx.mount(html`<main class="shell no-tabs"><header class="topbar"><a class="back" href="#/shelf">← 서재</a></header><p class="empty-line">${err.message}</p></main>`);
    return;
  }
  if (!ctx.isCurrent("timer")) return;
  if (!item) {
    ctx.mount('<main class="shell no-tabs"><header class="topbar"><a class="back" href="#/shelf">← 서재</a></header><section class="soon"><h2>돌고 있는 타이머가 없어요</h2><p>책 화면에서 [독서 시작]을 누르면 시간을 재요.</p></section></main>');
    return;
  }
  const shelf = item.shelf || {};
  const book = shelf.book || {};
  const started = Date.parse(item.started_at);
  let frozen = null; // [멈춤]을 누른 시각
  ctx.mount(html`
    <main class="shell no-tabs timer">
      <header class="topbar"><a class="back" href="#/book/${item.shelf_id}">← ${book.title || "책"}</a></header>
      <p class="timer-state" id="timer-state">읽는 중</p>
      <p class="clock" id="clock" role="timer" aria-label="읽은 시간">0:00:00</p>
      <p class="hint center">${timeText(item.started_at)}에 시작 · 앱을 닫거나 화면이 꺼져도 시간은 계속 가요.</p>
      <div id="run-actions"><button class="btn btn-primary btn-block btn-big" type="button" id="pause">멈춤</button></div>
      <form class="form stop-form" id="stop-form" novalidate hidden>
        <p class="stop-summary" id="stop-summary"></p>
        <p class="cap-error" id="long-note" hidden>6시간이 넘었어요. 멈춤을 잊으셨다면 실제로 읽은 시간을 고쳐 주세요.</p>
        <div class="field" id="min-field" hidden>
          <label for="stop-minutes">실제로 읽은 시간 (분)</label>
          <input id="stop-minutes" name="stop-minutes" type="text" inputmode="numeric" autocomplete="off">
        </div>
        <button class="link-btn" type="button" id="fix-min">읽은 시간 고치기</button>
        ${raw(ctx.field({ id: "stop-page", label: "몇 쪽까지 읽었나요? (선택)", inputmode: "numeric",
          hint: shelf.total_pages ? `지금 ${shelf.current_page ?? 0}쪽 / 전체 ${shelf.total_pages}쪽` : shelf.current_page ? `지금 ${shelf.current_page}쪽` : "" }))}
        <p class="form-error" role="alert"></p>
        <button class="btn btn-primary btn-block" type="submit">저장</button>
        <div class="row-actions center">
          <button class="btn btn-quiet btn-small" type="button" id="resume">계속 읽기</button>
          <button class="btn btn-warn btn-small" type="button" id="cancel">기록하지 않고 끝내기</button>
        </div>
      </form>
    </main>`);
  const $ = (s) => ctx.app.querySelector(s);
  const form = $("#stop-form");
  const clockEl = $("#clock");
  every(() => { if (clockEl.isConnected) clockEl.textContent = clock((frozen ?? serverNow()) - started); });
  const elapsedMin = () => Math.round(((frozen ?? serverNow()) - started) / 60000);

  $("#pause").addEventListener("click", () => {
    frozen = serverNow();
    const m = elapsedMin();
    $("#timer-state").textContent = "멈춤";
    $("#run-actions").hidden = true;
    form.hidden = false;
    const long = m > 360;
    $("#stop-summary").textContent = m < 1 ? "1분이 안 됐어요." : `${minutesText(Math.min(m, 1440))} 읽었어요.`;
    $("#long-note").hidden = !long;
    $("#min-field").hidden = !long;
    $("#fix-min").hidden = long;
    $("#stop-minutes").value = String(Math.min(m, 1440));
    (long ? $("#stop-minutes") : $("#stop-page")).focus();
  });
  $("#fix-min").addEventListener("click", () => { $("#min-field").hidden = false; $("#fix-min").hidden = true; $("#stop-minutes").focus(); });
  $("#resume").addEventListener("click", () => {
    frozen = null;
    $("#timer-state").textContent = "읽는 중";
    form.hidden = true;
    $("#run-actions").hidden = false;
    ctx.showError(form, "");
  });
  $("#cancel").addEventListener("click", async (e) => {
    const ok = await confirmBox({ title: "기록하지 않고 끝낼까요?", body: "이번에 잰 시간은 저장되지 않아요.", ok: "끝내기", danger: true });
    if (!ok) return;
    busy(e.target, async () => {
      try { await api.logs.cancel(item.id); forgetRunning(); toast("타이머를 끝냈어요."); ctx.replace(`book/${item.shelf_id}`); }
      catch (err) { toast(err.message); }
    });
  });
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const m = elapsedMin();
    let minutes = Math.min(m, 1440);
    if (!$("#min-field").hidden) {
      const v = $("#stop-minutes").value.trim();
      minutes = Number(v);
      if (!v || !Number.isInteger(minutes) || minutes < 1 || minutes > 1440) return ctx.showError(form, "실제로 읽은 시간은 1~1440 사이 숫자(분)로 적어 주세요.", "stop-minutes");
      if (minutes > m + 1) return ctx.showError(form, "읽은 시간이 타이머보다 길어요.", "stop-minutes");
    } else if (m < 1) {
      return ctx.showError(form, "1분 이상 읽었을 때 저장할 수 있어요. [계속 읽기]나 [기록하지 않고 끝내기]를 눌러 주세요.");
    }
    const pageRaw = $("#stop-page").value.trim();
    const page = pageRaw === "" ? null : Number(pageRaw);
    if (page !== null && (!Number.isInteger(page) || page < 0 || page > 20000)) return ctx.showError(form, "쪽수는 0~20000 사이 숫자로 적어 주세요.", "stop-page");
    if (page !== null && shelf.total_pages && page > shelf.total_pages) return ctx.showError(form, `끝낸 쪽이 전체 쪽수(${shelf.total_pages}쪽)보다 많아요.`, "stop-page");
    busy(form.querySelector("[type=submit]"), async () => {
      try {
        await api.logs.stop(item.id, { minutes, end_page: page });
        forgetRunning();
        toast(`${minutesText(minutes)}을 적었어요.`);
        ctx.replace(`book/${item.shelf_id}`);
      } catch (err) { ctx.showError(form, err.message); }
    });
  });

  // 다시 화면으로 돌아왔을 때: 다른 기기에서 멈췄는지 확인
  const onVisible = async () => {
    if (document.hidden || !ctx.isCurrent("timer")) return;
    try {
      const now = await loadRunning(true);
      if (!ctx.isCurrent("timer")) return;
      if (!now || now.id !== item.id) { toast("다른 기기에서 끝낸 타이머예요."); ctx.replace(`book/${item.shelf_id}`); }
    } catch { /* 인터넷이 잠깐 끊겨도 시계는 계속 */ }
  };
  document.addEventListener("visibilitychange", onVisible);
  cleanups.push(() => document.removeEventListener("visibilitychange", onVisible));
}

// ── 손으로 적기 · 고치기 ────────────────────────────────────
export async function viewLog(ctx, shelfId, logId) {
  const route = `log/${shelfId}${logId ? `/${logId}` : ""}`;
  ctx.mount('<main class="shell no-tabs"><p class="empty-line">불러오는 중…</p></main>');
  let shelf;
  let log = null;
  try {
    const [s, l] = await Promise.all([api.shelf.get(shelfId), logId ? api.logs.list(shelfId) : null]);
    shelf = s.item;
    if (logId) {
      log = l.items.find((x) => x.id === logId);
      if (!log) throw new Error("독서 기록을 찾을 수 없어요. 이미 지웠을 수 있어요.");
    }
  } catch (err) {
    if (ctx.isCurrent(route)) ctx.mount(html`<main class="shell no-tabs"><header class="topbar"><a class="back" href="#/book/${shelfId}">← 책</a></header><p class="empty-line">${err.message}</p></main>`);
    return;
  }
  if (!ctx.isCurrent(route)) return;
  const b = shelf.book || {};
  ctx.mount(html`
    <main class="shell no-tabs">
      <header class="topbar"><a class="back" href="#/book/${shelfId}">← ${b.title || "책"}</a></header>
      <h1 class="who">${log ? "독서 시간 고치기" : "독서 시간 적기"}</h1>
      ${raw(log && log.method === "timer" ? html`<p class="hint">${timeText(log.started_at)}에 타이머로 잰 기록이에요.</p>` : "")}
      <form class="form" id="log-form" novalidate>
        ${raw(ctx.field({ id: "log-day", label: "읽은 날", type: "date", value: log ? log.read_on : kstToday() }))}
        <div class="field">
          <label for="log-min">읽은 시간 (분)</label>
          <div class="input-wrap"><input id="log-min" name="log-min" type="text" inputmode="numeric" autocomplete="off" value="${log ? log.minutes : ""}"></div>
          <div class="quick-min" role="group" aria-label="빨리 고르기">${[10, 20, 30, 60, 90].map((m) => raw(html`<button type="button" class="chip-btn" data-min="${m}">${minutesText(m)}</button>`))}</div>
        </div>
        ${raw(ctx.field({ id: "log-page", label: "몇 쪽까지 읽었나요? (선택)", inputmode: "numeric", value: log?.end_page ?? "",
          hint: shelf.total_pages ? `전체 ${shelf.total_pages}쪽` : "" }))}
        <p class="form-error" role="alert"></p>
        <button class="btn btn-primary btn-block" type="submit">${log ? "고친 내용 저장" : "저장"}</button>
        ${raw(log ? '<button class="btn btn-warn" type="button" id="log-remove">이 기록 지우기</button>' : "")}
      </form>
    </main>`);
  const form = ctx.app.querySelector("#log-form");
  const dayInput = form.querySelector("#log-day");
  dayInput.max = kstToday();
  form.querySelectorAll("[data-min]").forEach((btn) => btn.addEventListener("click", () => { form.querySelector("#log-min").value = btn.dataset.min; }));
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const day = dayInput.value;
    if (!day) return ctx.showError(form, "읽은 날을 골라 주세요.", "log-day");
    if (day > kstToday()) return ctx.showError(form, "오늘 이후 날짜는 적을 수 없어요.", "log-day");
    const mv = form.querySelector("#log-min").value.trim();
    const minutes = Number(mv);
    if (!mv || !Number.isInteger(minutes) || minutes < 1 || minutes > 1440) return ctx.showError(form, "읽은 시간은 1~1440 사이 숫자(분)로 적어 주세요.", "log-min");
    const pv = form.querySelector("#log-page").value.trim();
    const page = pv === "" ? null : Number(pv);
    if (page !== null && (!Number.isInteger(page) || page < 0 || page > 20000)) return ctx.showError(form, "쪽수는 0~20000 사이 숫자로 적어 주세요.", "log-page");
    if (page !== null && shelf.total_pages && page > shelf.total_pages) return ctx.showError(form, `끝낸 쪽이 전체 쪽수(${shelf.total_pages}쪽)보다 많아요.`, "log-page");
    busy(form.querySelector("[type=submit]"), async () => {
      try {
        if (log) await api.logs.update(log.id, { read_on: day, minutes, end_page: page });
        else await api.logs.add({ shelf_id: shelfId, read_on: day, minutes, end_page: page });
        toast(log ? "고친 내용을 저장했어요." : `${minutesText(minutes)}을 적었어요.`);
        ctx.replace(`book/${shelfId}`);
      } catch (err) { ctx.showError(form, err.message); }
    });
  });
  form.querySelector("#log-remove")?.addEventListener("click", async (e) => {
    const ok = await confirmBox({ title: "이 기록을 지울까요?", body: `${dayText(log.read_on)} ${minutesText(log.minutes)} 기록이 지워지고 되돌릴 수 없어요.`, ok: "지우기", danger: true });
    if (!ok) return;
    busy(e.target, async () => {
      try { await api.logs.remove(log.id); toast("기록을 지웠어요."); ctx.replace(`book/${shelfId}`); }
      catch (err) { toast(err.message); }
    });
  });
}
