// book-log 화면 (1단계: 가입 · 로그인 · 승인 대기 · 나 · 관리자 / 2단계: books.js / 3단계: capture.js · notes.js)
import { api, ApiError, session } from "./api.js";
import { resetBooks, stopScanner, viewAdd, viewBook, viewConfirm, viewManual, viewScan, viewShelf } from "./books.js";
import { leaveCapture, resetCapture, viewCapture } from "./capture.js";
import { resetNotes, viewNote, viewNotes, viewWrite } from "./notes.js";
import { APP_VERSION } from "./config.js";
import { busy, confirmBox, formatDate, html, raw, secretBox, toast } from "./ui.js";

const app = document.getElementById("app");
const state = { user: null, pendingCount: 0 };

// ── 아이콘 (선만 쓰는 단순한 모양) ─────────────────────────
const ICON = {
  shelf: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 20V5M8 20V4M12 20l3.5-15 4 1L16 21"/><path d="M3 20h18"/></svg>`,
  notes: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 3h9l3 3v15H6z"/><path d="M9 10h6M9 14h6M9 18h3"/></svg>`,
  explore: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="9" cy="8" r="3"/><circle cx="17" cy="10" r="2.5"/><path d="M3 20c.5-3.5 3-5.5 6-5.5s5.5 2 6 5.5M15 15.5c2.8-.4 5 1.3 5.5 4.5"/></svg>`,
  stats: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 20h16"/><path d="M7 20v-6M12 20V8M17 20v-9"/></svg>`,
};

const TABS = [
  { route: "shelf", label: "서재", icon: ICON.shelf },
  { route: "notes", label: "기록", icon: ICON.notes },
  { route: "explore", label: "둘러보기", icon: ICON.explore },
  { route: "stats", label: "통계", icon: ICON.stats },
];

function tabbar(current) {
  return html`<nav class="tabbar" aria-label="주요 화면"><ul>${TABS.map((t) => raw(html`
    <li><a href="#/${t.route}" ${raw(t.route === current ? 'aria-current="page"' : "")}>${raw(t.icon)}<span>${t.label}</span></a></li>`))}
  </ul></nav>`;
}

function meButton() {
  const initial = (state.user?.display_name || "?").slice(0, 1);
  const dot = state.user?.is_admin && state.pendingCount > 0 ? '<span class="dot" aria-hidden="true"></span>' : "";
  const label = dot ? "나 (승인 기다리는 회원 있음)" : "나";
  return html`<button class="me-btn" data-go="me" aria-label="${label}">${initial}${raw(dot)}</button>`;
}

function mount(markup) {
  app.innerHTML = markup;
  app.querySelectorAll("[data-go]").forEach((el) =>
    el.addEventListener("click", () => go(el.dataset.go)));
  const h = app.querySelector("h1");
  if (h) document.title = `${h.textContent.trim()} · book-log`;
  window.scrollTo(0, 0);
}

function go(route) {
  if (location.hash === `#/${route}`) render();
  else location.hash = `#/${route}`;
}

// ── 공통 폼 도우미 ───────────────────────────────────────
function field({ id, label, type = "text", hint = "", autocomplete = "", inputmode = "", peek = false, value = "" }) {
  return html`
    <div class="field">
      <label for="${id}">${label}</label>
      <div class="input-wrap">
        <input id="${id}" name="${id}" type="${type}" value="${value}"
          ${raw(autocomplete ? `autocomplete="${autocomplete}"` : "")}
          ${raw(inputmode ? `inputmode="${inputmode}"` : "")}
          ${raw(hint ? `aria-describedby="${id}-hint"` : "")}
          autocapitalize="off" spellcheck="false">
        ${raw(peek ? `<button type="button" class="peek" data-peek="${id}" aria-label="비밀번호 보기">보기</button>` : "")}
      </div>
      ${raw(hint ? html`<span class="hint" id="${id}-hint">${hint}</span>` : "")}
    </div>`;
}

function wirePeek(root) {
  root.querySelectorAll("[data-peek]").forEach((b) => b.addEventListener("click", () => {
    const input = root.querySelector(`#${b.dataset.peek}`);
    const show = input.type === "password";
    input.type = show ? "text" : "password";
    b.textContent = show ? "숨기기" : "보기";
    b.setAttribute("aria-label", show ? "비밀번호 숨기기" : "비밀번호 보기");
  }));
}

function showError(form, message, focusId) {
  const box = form.querySelector(".form-error");
  box.textContent = message;
  form.querySelectorAll("input").forEach((i) => i.removeAttribute("aria-invalid"));
  if (focusId) {
    const input = form.querySelector(`#${focusId}`);
    input?.setAttribute("aria-invalid", "true");
    input?.focus();
  }
}

// ── 로그인 ──────────────────────────────────────────────
function viewLogin(message = "") {
  mount(html`
    <main class="shell no-tabs gate">
      <div class="mark" aria-hidden="true"></div>
      <h1 class="wordmark">book-log</h1>
      <p class="tagline">읽은 책과 마음에 남은 문장을 적어 두는 곳</p>
      <form class="form" id="login" novalidate>
        ${raw(field({ id: "username", label: "아이디", autocomplete: "username" }))}
        ${raw(field({ id: "password", label: "비밀번호", type: "password", autocomplete: "current-password", peek: true }))}
        <p class="form-error" role="alert">${message}</p>
        <button class="btn btn-primary btn-block" type="submit">로그인</button>
      </form>
      <p class="switch-line">처음 오셨나요? <a href="#/signup">가입 신청하기</a></p>
    </main>`);
  const form = app.querySelector("#login");
  wirePeek(form);
  form.username.focus();
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const username = form.username.value.trim();
    const password = form.password.value;
    if (!username) return showError(form, "아이디를 입력해 주세요.", "username");
    if (!password) return showError(form, "비밀번호를 입력해 주세요.", "password");
    busy(form.querySelector("[type=submit]"), async () => {
      try {
        const r = await api.login(username, password);
        session.token = r.token;
        state.user = r.user;
        afterSignIn();
      } catch (err) {
        showError(form, err.message, err.status === 401 ? "password" : "");
      }
    });
  });
}

// ── 가입 신청 ────────────────────────────────────────────
function viewSignup() {
  mount(html`
    <main class="shell no-tabs gate">
      <header class="topbar"><h1>가입 신청</h1></header>
      <p class="tagline">관리자가 승인하면 바로 쓸 수 있어요.</p>
      <form class="form" id="signup" novalidate>
        ${raw(field({ id: "username", label: "아이디", autocomplete: "username", hint: "영문 소문자, 숫자, 밑줄(_)로 3~20자" }))}
        ${raw(field({ id: "display_name", label: "이름", autocomplete: "nickname", hint: "다른 회원에게 보이는 이름이에요" }))}
        ${raw(field({ id: "password", label: "비밀번호", type: "password", autocomplete: "new-password", hint: "8자 이상, 영문과 숫자를 함께", peek: true }))}
        ${raw(field({ id: "password2", label: "비밀번호 한 번 더", type: "password", autocomplete: "new-password" }))}
        <p class="form-error" role="alert"></p>
        <button class="btn btn-primary btn-block" type="submit">가입 신청 보내기</button>
      </form>
      <p class="switch-line">이미 계정이 있나요? <a href="#/login">로그인</a></p>
    </main>`);
  const form = app.querySelector("#signup");
  wirePeek(form);
  form.username.focus();
  form.username.addEventListener("input", () => {
    const pos = form.username.selectionStart;
    form.username.value = form.username.value.toLowerCase();
    form.username.setSelectionRange(pos, pos);
  });
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const username = form.username.value.trim().toLowerCase();
    const name = form.display_name.value.trim();
    const pw = form.password.value;
    if (!/^[a-z0-9_]{3,20}$/.test(username)) return showError(form, "아이디는 영문 소문자·숫자·밑줄(_)로 3~20자입니다.", "username");
    if (!name || name.length > 20) return showError(form, "이름은 1~20자로 적어 주세요.", "display_name");
    if (pw.length < 8 || !/[a-zA-Z]/.test(pw) || !/[0-9]/.test(pw)) return showError(form, "비밀번호는 8자 이상, 영문과 숫자를 함께 넣어 주세요.", "password");
    if (pw !== form.password2.value) return showError(form, "두 비밀번호가 서로 달라요.", "password2");
    busy(form.querySelector("[type=submit]"), async () => {
      try {
        const r = await api.signup(username, pw, name);
        session.token = r.token;
        state.user = r.user;
        afterSignIn();
      } catch (err) {
        showError(form, err.message, err.status === 409 ? "username" : "");
      }
    });
  });
}

// ── 승인 대기 ────────────────────────────────────────────
let waitTimer;
function viewPending() {
  const u = state.user;
  mount(html`
    <main class="shell no-tabs waiting">
      <h1>승인을 기다리고 있어요</h1>
      <p>${u.display_name}님의 가입 신청이 관리자에게 전달됐어요.</p>
      <p>승인되면 이 화면이 저절로 서재로 바뀝니다.</p>
      <p class="checked" id="checked">방금 확인했어요</p>
      <div class="actions">
        <button class="btn btn-primary" id="check">지금 확인하기</button>
        <button class="btn btn-quiet" id="out">로그아웃</button>
      </div>
    </main>`);
  const check = async () => {
    try {
      const r = await api.me();
      state.user = r.user;
      if (r.user.status === "approved") { stopWaiting(); toast("승인됐어요. 환영합니다!"); go("shelf"); return; }
      const t = new Date();
      const el = document.getElementById("checked");
      if (el) el.textContent = `${t.getHours()}시 ${String(t.getMinutes()).padStart(2, "0")}분에 확인했어요`;
    } catch (err) {
      if (!(err instanceof ApiError) || err.status !== 0) stopWaiting();
      else toast(err.message);
    }
  };
  app.querySelector("#check").addEventListener("click", (e) => busy(e.currentTarget, check));
  app.querySelector("#out").addEventListener("click", signOut);
  stopWaiting();
  waitTimer = setInterval(() => { if (!document.hidden) check(); }, 20000);
}
function stopWaiting() { clearInterval(waitTimer); }

// ── 서재 (1단계: 빈 서재) ────────────────────────────────
let installEvent = null;
window.addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); installEvent = e; });
const isStandalone = () => matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;

function pendingNote() {
  return state.user.is_admin && state.pendingCount > 0
    ? html`<div class="notice"><p>승인을 기다리는 회원이 ${state.pendingCount}명 있어요.</p><button class="btn btn-primary btn-small" data-go="admin">보기</button></div>`
    : "";
}

function installBlock() {
  return isStandalone() ? "" : html`
    <section class="install" aria-labelledby="install-title">
      <h2 class="section-title" id="install-title">홈 화면에 붙이기</h2>
      <p>홈 화면에 붙이면 주소창 없이 앱처럼 열려요.</p>
      ${raw(installEvent
        ? '<button class="btn btn-quiet" id="install">홈 화면에 추가</button>'
        : "<p>크롬 오른쪽 위 ⋮ 메뉴에서 「홈 화면에 추가」를 누르세요.</p>")}
    </section>`;
}

function wireInstall() {
  app.querySelector("#install")?.addEventListener("click", async () => {
    installEvent.prompt();
    await installEvent.userChoice;
    installEvent = null;
    render();
  });
}

// ── 준비 중인 탭 ─────────────────────────────────────────
const SOON = {
  explore: { title: "둘러보기", h: "회원들이 공개한 책장이 보여요", p: "책마다 공개를 켜면 승인된 회원끼리 서로의 기록을 볼 수 있게 됩니다." },
  stats: { title: "통계", h: "한 달에 읽은 책과 시간이 보여요", p: "읽은 권수, 읽은 시간, 하루 평균, 이어서 읽은 날을 달마다 보여 드릴 예정이에요." },
};
function viewSoon(route) {
  const s = SOON[route];
  mount(html`
    <main class="shell">
      <header class="topbar"><h1>${s.title}</h1>${raw(meButton())}</header>
      <section class="soon"><h2>${s.h}</h2><p>${s.p}</p></section>
    </main>
    ${raw(tabbar(route))}`);
}

// ── 나 ──────────────────────────────────────────────────
function viewMe() {
  const u = state.user;
  mount(html`
    <main class="shell no-tabs">
      <header class="topbar"><button class="back" data-go="shelf">← 서재</button></header>
      <section class="block">
        <h1 class="who">${u.display_name}</h1>
        <p class="who-sub">@${u.username} · ${formatDate(u.created_at)} 가입${u.is_admin ? " · 관리자" : ""}</p>
      </section>
      ${raw(u.is_admin ? html`
      <section class="block">
        <h2>관리</h2>
        <button class="btn btn-primary" data-go="admin">회원 관리${state.pendingCount ? ` (승인 대기 ${state.pendingCount}명)` : ""}</button>
      </section>` : "")}
      <section class="block">
        <h2>이름 바꾸기</h2>
        <form class="form" id="rename" novalidate>
          ${raw(field({ id: "display_name", label: "보이는 이름", value: u.display_name }))}
          <p class="form-error" role="alert"></p>
          <button class="btn btn-quiet" type="submit">이름 저장</button>
        </form>
      </section>
      <section class="block">
        <h2>비밀번호 바꾸기</h2>
        <form class="form" id="pw" novalidate>
          ${raw(field({ id: "current", label: "지금 비밀번호", type: "password", autocomplete: "current-password", peek: true }))}
          ${raw(field({ id: "next", label: "새 비밀번호", type: "password", autocomplete: "new-password", hint: "8자 이상, 영문과 숫자를 함께", peek: true }))}
          ${raw(field({ id: "next2", label: "새 비밀번호 한 번 더", type: "password", autocomplete: "new-password" }))}
          <p class="form-error" role="alert"></p>
          <button class="btn btn-quiet" type="submit">비밀번호 저장</button>
        </form>
      </section>
      <section class="block">
        <button class="btn btn-warn" id="out">로그아웃</button>
        <p class="version">book-log ${APP_VERSION}</p>
      </section>
    </main>`);
  const rename = app.querySelector("#rename");
  rename.addEventListener("submit", (e) => {
    e.preventDefault();
    const name = rename.display_name.value.trim();
    if (!name || name.length > 20) return showError(rename, "이름은 1~20자로 적어 주세요.", "display_name");
    busy(rename.querySelector("[type=submit]"), async () => {
      try {
        const r = await api.rename(name);
        state.user = r.user;
        showError(rename, "");
        toast("이름을 저장했어요.");
      } catch (err) { showError(rename, err.message); }
    });
  });
  const pw = app.querySelector("#pw");
  wirePeek(pw);
  pw.addEventListener("submit", (e) => {
    e.preventDefault();
    const next = pw.next.value;
    if (!pw.current.value) return showError(pw, "지금 비밀번호를 입력해 주세요.", "current");
    if (next.length < 8 || !/[a-zA-Z]/.test(next) || !/[0-9]/.test(next)) return showError(pw, "새 비밀번호는 8자 이상, 영문과 숫자를 함께 넣어 주세요.", "next");
    if (next !== pw.next2.value) return showError(pw, "새 비밀번호 두 개가 서로 달라요.", "next2");
    busy(pw.querySelector("[type=submit]"), async () => {
      try {
        await api.changePassword(pw.current.value, next);
        pw.reset();
        showError(pw, "");
        toast("비밀번호를 바꿨어요. 다른 기기에서는 다시 로그인해야 해요.");
      } catch (err) { showError(pw, err.message, err.status === 401 ? "current" : ""); }
    });
  });
  app.querySelector("#out").addEventListener("click", signOut);
}

// ── 관리자 ──────────────────────────────────────────────
const STATE_LABEL = { pending: "승인 대기", approved: "사용 중", disabled: "사용 중지", rejected: "거절됨" };
let adminFilter = "pending";

async function viewAdmin() {
  if (!state.user.is_admin) return go("shelf");
  mount(html`
    <main class="shell no-tabs">
      <header class="topbar"><button class="back" data-go="me">← 나</button></header>
      <h1 class="who">회원 관리</h1>
      <div class="segments" role="group" aria-label="보기">
        <button data-filter="pending" aria-pressed="${adminFilter === "pending"}">승인 대기</button>
        <button data-filter="all" aria-pressed="${adminFilter === "all"}">모든 회원</button>
      </div>
      <ul class="people" id="people"><li class="person"><p class="person-meta">불러오는 중…</p></li></ul>
      <section class="block" id="settings-block">
        <h2>글자 읽기 하루 한도</h2>
        <form class="inline-form" id="limit" novalidate>
          ${raw(field({ id: "limit_value", label: "한 사람이 하루에 [글자 읽기]를 누를 수 있는 횟수", inputmode: "numeric" }))}
          <button class="btn btn-quiet" type="submit">저장</button>
        </form>
      </section>
      <section class="block" id="usage-block">
        <h2>글자 읽기 사용량</h2>
        <div id="usage"><p class="person-meta">불러오는 중…</p></div>
      </section>
    </main>`);
  app.querySelectorAll("[data-filter]").forEach((b) => b.addEventListener("click", () => {
    adminFilter = b.dataset.filter;
    viewAdmin();
  }));
  await Promise.all([loadPeople(), loadSettings(), loadUsage()]);
}

async function loadUsage() {
  const box = app.querySelector("#usage");
  if (!box) return;
  try {
    const u = await api.admin.usage();
    const month = Number(u.month_start.slice(5, 7));
    box.innerHTML = html`
      <p class="usage-big"><strong>${u.month}</strong>번 <span>${month}월 전체</span></p>
      <p class="person-meta">오늘 ${u.today_count}번${u.failed ? ` · 이번 달 실패 ${u.failed}번` : ""} · 구글 무료 범위는 한 달 1,000번</p>
      ${raw(u.users.length ? html`<ul class="people">${u.users.map((x) => raw(html`<li class="person usage-row">
        <span class="person-name">${x.display_name} <small>@${x.username}</small></span>
        <span class="person-meta">이번 달 ${x.month}번 · 오늘 ${x.today}번${x.failed ? ` · 실패 ${x.failed}` : ""}</span></li>`))}</ul>` : "")}`;
  } catch (err) {
    box.innerHTML = html`<p class="person-meta">${err.message}</p>`;
  }
}

async function loadPeople() {
  const list = app.querySelector("#people");
  if (!list) return;
  let users;
  try {
    ({ users } = await api.admin.users());
  } catch (err) {
    list.innerHTML = html`<li class="person"><p class="person-meta">${err.message}</p></li>`;
    return;
  }
  state.pendingCount = users.filter((u) => u.status === "pending").length;
  const pendBtn = app.querySelector('[data-filter="pending"]');
  if (pendBtn) pendBtn.textContent = `승인 대기 ${state.pendingCount}`;
  const shown = adminFilter === "pending" ? users.filter((u) => u.status === "pending") : users;
  if (!shown.length) {
    list.innerHTML = html`<li class="person"><p class="person-meta">${adminFilter === "pending" ? "승인을 기다리는 회원이 없어요." : "회원이 없어요."}</p></li>`;
    return;
  }
  list.innerHTML = shown.map((u) => {
    const self = u.id === state.user.id;
    let actions = "";
    if (!self) {
      if (u.status === "pending") actions = html`
        <button class="btn btn-primary btn-small" data-act="approve" data-id="${u.id}">승인</button>
        <button class="btn btn-warn btn-small" data-act="reject" data-id="${u.id}">거절</button>`;
      else if (u.status === "approved") actions = html`
        <button class="btn btn-quiet btn-small" data-act="reset" data-id="${u.id}">임시 비밀번호</button>
        <button class="btn btn-warn btn-small" data-act="disable" data-id="${u.id}">사용 중지</button>`;
      else actions = html`<button class="btn btn-quiet btn-small" data-act="enable" data-id="${u.id}">다시 승인</button>`;
    }
    return html`
      <li class="person">
        <div class="person-head">
          <p class="person-name">${u.display_name}${self ? " (나)" : ""}</p>
          <span class="state state-${u.status}">${STATE_LABEL[u.status]}</span>
        </div>
        <p class="person-meta">@${u.username} · ${formatDate(u.created_at)} 가입${u.locked ? " · 비밀번호 잠김" : ""}</p>
        ${raw(actions ? `<div class="person-actions">${actions}</div>` : "")}
      </li>`;
  }).join("");
  list.querySelectorAll("[data-act]").forEach((b) => b.addEventListener("click", () => act(b, users.find((u) => u.id === b.dataset.id))));
}

async function act(button, u) {
  const who = `${u.display_name}(@${u.username})`;
  const plan = {
    approve: { ask: null, run: () => api.admin.approve(u.id), done: `${u.display_name}님을 승인했어요.` },
    reject: { ask: { title: "가입을 거절할까요?", body: `${who}님은 로그인할 수 없게 됩니다. 나중에 [다시 승인]할 수 있어요.`, ok: "거절", danger: true }, run: () => api.admin.reject(u.id), done: "거절했어요." },
    disable: { ask: { title: "사용을 중지할까요?", body: `${who}님은 바로 로그아웃되고 로그인할 수 없게 됩니다. 기록은 지워지지 않아요.`, ok: "사용 중지", danger: true }, run: () => api.admin.disable(u.id), done: "사용을 중지했어요." },
    enable: { ask: null, run: () => api.admin.enable(u.id), done: `${u.display_name}님을 다시 승인했어요.` },
    reset: { ask: { title: "임시 비밀번호를 만들까요?", body: `${who}님의 지금 비밀번호는 더 이상 쓸 수 없고, 모든 기기에서 로그아웃됩니다.`, ok: "만들기", danger: true }, run: () => api.admin.resetPassword(u.id), done: null },
  }[button.dataset.act];
  if (plan.ask && !(await confirmBox(plan.ask))) return;
  await busy(button, async () => {
    try {
      const r = await plan.run();
      if (button.dataset.act === "reset") {
        secretBox({
          title: "임시 비밀번호",
          body: `${who}님에게 알려 주세요. 이 창을 닫으면 다시 볼 수 없어요. 로그인한 뒤 [나]에서 비밀번호를 바꾸도록 안내해 주세요.`,
          secret: r.temp_password,
        });
      } else toast(plan.done);
    } catch (err) { toast(err.message); }
  });
  await loadPeople();
}

async function loadSettings() {
  const form = app.querySelector("#limit");
  if (!form) return;
  try {
    const { settings } = await api.admin.settings();
    form.limit_value.value = settings.ocr_daily_limit ?? 100;
  } catch { /* 목록 쪽에서 이미 오류를 보여 줌 */ }
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const n = Number(form.limit_value.value);
    if (!Number.isInteger(n) || n < 1 || n > 1000) return toast("1~1000 사이 숫자로 적어 주세요.");
    busy(form.querySelector("[type=submit]"), async () => {
      try { await api.admin.setSetting("ocr_daily_limit", n); toast(`하루 ${n}번으로 저장했어요.`); }
      catch (err) { toast(err.message); }
    });
  });
}

// ── 2단계 화면에 넘겨 주는 도구 모음 ──────────────────────
const ctx = {
  app, state, mount, go, tabbar, meButton, field, showError, pendingNote, installBlock,
  replace: (route) => { history.replaceState(null, "", `#/${route}`); render(); },
  afterShelfMount: wireInstall,
  isCurrent: (r) => currentRoute() === r,
};

// ── 로그인 흐름 · 길 찾기 ────────────────────────────────
async function refreshPendingCount() {
  if (!state.user?.is_admin) return;
  try {
    const { users } = await api.admin.users();
    const n = users.filter((u) => u.status === "pending").length;
    if (n !== state.pendingCount) {
      state.pendingCount = n;
      const r = currentRoute();
      if (r === "shelf" || TABS.some((t) => t.route === r)) render();
    }
  } catch { /* 조용히 넘어감 */ }
}

function afterSignIn() {
  if (state.user.status === "approved") {
    refreshPendingCount();
    go("shelf");
  } else go("pending");
}

async function signOut() {
  stopWaiting();
  try { await api.logout(); } catch { /* 이미 끊긴 출입증 */ }
  session.clear();
  resetBooks();
  resetCapture();
  resetNotes();
  state.user = null;
  state.pendingCount = 0;
  go("login");
}

window.addEventListener("bk:signed-out", (e) => {
  state.user = null;
  resetBooks();
  resetCapture();
  resetNotes();
  stopWaiting();
  viewLogin(e.detail || "다시 로그인해 주세요.");
  history.replaceState(null, "", "#/login");
});

const currentRoute = () => (location.hash.replace(/^#\/?/, "").split("?")[0] || "shelf");

function render() {
  const route = currentRoute();
  stopScanner();
  leaveCapture();
  if (route !== "pending") stopWaiting();
  if (!state.user) {
    if (route === "signup") return viewSignup();
    if (route !== "login") return history.replaceState(null, "", "#/login"), viewLogin();
    return viewLogin();
  }
  if (state.user.status !== "approved") {
    if (route !== "pending") history.replaceState(null, "", "#/pending");
    return viewPending();
  }
  const [head, arg, sub] = route.split("/");
  switch (head) {
    case "shelf": return viewShelf(ctx);
    case "add": return viewAdd(ctx);
    case "scan": return viewScan(ctx);
    case "add-confirm": return viewConfirm(ctx);
    case "add-manual": return viewManual(ctx);
    case "book": return arg ? viewBook(ctx, arg) : go("shelf");
    case "capture": return viewCapture(ctx, arg, sub);
    case "write": return arg ? viewWrite(ctx, arg) : go("shelf");
    case "note": return arg ? viewNote(ctx, arg) : go("notes");
    case "notes": return viewNotes(ctx);
    case "explore": case "stats": return viewSoon(route);
    case "me": return viewMe();
    case "admin": return viewAdmin();
    default: return go("shelf");
  }
}

window.addEventListener("hashchange", render);

async function boot() {
  if (session.token) {
    try {
      const r = await api.me();
      state.user = r.user;
      if (state.user.status === "approved") refreshPendingCount();
    } catch (err) {
      if (err.status === 0) {
        app.innerHTML = html`<main class="shell no-tabs waiting"><h1>연결할 수 없어요</h1><p>${err.message}</p><div class="actions"><button class="btn btn-primary" id="retry">다시 시도</button></div></main>`;
        app.querySelector("#retry").addEventListener("click", boot);
        return;
      }
      session.clear();
    }
  }
  const r = currentRoute();
  if (state.user && (r === "login" || r === "signup")) return afterSignIn();
  render();
}

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("/sw.js").catch(() => {}));
}
boot();
