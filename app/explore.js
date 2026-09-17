// book-log 5단계 화면: 둘러보기 (회원별 공개 책장 · 최근 공개 문장 · 공개한 책 보기)
import { api } from "./api.js";
import { formatDate, html, raw } from "./ui.js";
import { dayText, minutesText } from "./reading.js";

const KIND = { capture: "찍은 문장", thought: "내 생각" };
const tab = { view: "users" };
export function resetExplore() { tab.view = "users"; }

export async function viewExplore(ctx) {
  const shell = (body) => ctx.mount(html`
    <main class="shell">
      <header class="topbar"><h1>둘러보기</h1>${raw(ctx.meButton())}</header>
      <div class="segments" role="group" aria-label="보기">
        <button type="button" data-view="users" aria-pressed="${tab.view === "users"}">회원</button>
        <button type="button" data-view="recent" aria-pressed="${tab.view === "recent"}">최근 문장</button>
      </div>
      ${raw(body)}
    </main>
    ${raw(ctx.tabbar("explore"))}`);
  const wire = () => ctx.app.querySelectorAll("[data-view]").forEach((b) => b.addEventListener("click", () => { tab.view = b.dataset.view; viewExplore(ctx); }));
  shell('<p class="empty-line">불러오는 중…</p>');
  wire();
  try {
    if (tab.view === "users") {
      const { users } = await api.publicShelves.users();
      if (!ctx.isCurrent("explore")) return;
      shell(users.length
        ? html`<ul class="note-list">${users.map((u) => raw(html`<li><a class="note-row" href="#/shared/${u.user_id}">
            <span class="note-text">${u.display_name}${u.me ? " (나)" : ""}</span>
            <span class="note-meta">공개한 책 ${u.books}권${u.last_at ? ` · ${formatDate(u.last_at)}` : ""}</span></a></li>`))}</ul>`
        : '<div class="soon"><h2>아직 공개한 책이 없어요</h2><p>책 화면 맨 아래 [이 책 공개하기]를 켜면 승인된 회원이 그 책의 기록을 볼 수 있어요.</p></div>');
    } else {
      const { items } = await api.publicShelves.recent();
      if (!ctx.isCurrent("explore")) return;
      shell(items.length
        ? html`<ul class="note-list">${items.map((n) => raw(html`<li><a class="note-row" href="#/shared-book/${n.shelf_id}">
            <span class="note-meta">${n.owner.display_name} · ${n.book?.title ?? "책"}${n.page !== null && n.page !== undefined ? ` · ${n.page}쪽` : ""}${n.has_photo ? " · 사진" : ""}</span>
            <span class="note-text reading">${n.text}</span></a></li>`))}</ul>`
        : '<div class="soon"><h2>공개된 문장이 아직 없어요</h2><p>회원이 책을 공개하면 여기에 최근 문장이 모여요.</p></div>');
    }
  } catch (err) {
    if (ctx.isCurrent("explore")) shell(html`<p class="empty-line">${err.message}</p>`);
    return;
  }
  wire();
}

export async function viewSharedShelf(ctx, userId) {
  const route = `shared/${userId}`;
  ctx.mount('<main class="shell no-tabs"><p class="empty-line">불러오는 중…</p></main>');
  let data;
  try { data = await api.publicShelves.shelf(userId); } catch (err) {
    if (ctx.isCurrent(route)) ctx.mount(html`<main class="shell no-tabs"><header class="topbar"><a class="back" href="#/explore">← 둘러보기</a></header><p class="empty-line">${err.message}</p></main>`);
    return;
  }
  if (!ctx.isCurrent(route)) return;
  ctx.mount(html`
    <main class="shell no-tabs">
      <header class="topbar"><a class="back" href="#/explore">← 둘러보기</a></header>
      <h1 class="who">${data.owner.display_name}님이 공개한 책</h1>
      ${raw(data.items.length
        ? html`<ul class="shelf-list">${data.items.map((x) => raw(html`<li><a class="book-row" href="#/shared-book/${x.id}">
            ${raw(x.book.cover_url ? html`<img class="cover" src="${x.book.cover_url}" alt="" loading="lazy" referrerpolicy="no-referrer">` : '<span class="cover cover-none" aria-hidden="true"></span>')}
            <span class="book-main"><span class="book-title">${x.book.title}</span>
              <span class="book-by">${(x.book.authors || []).join(", ")}</span>
              <span class="note-meta">메모 ${x.note_count}개${x.total_minutes ? ` · ${minutesText(x.total_minutes)}` : ""}</span></span></a></li>`))}</ul>`
        : '<p class="empty-line">지금은 공개한 책이 없어요.</p>')}
    </main>`);
}

export async function viewSharedBook(ctx, shelfId) {
  const route = `shared-book/${shelfId}`;
  ctx.mount('<main class="shell no-tabs"><p class="empty-line">불러오는 중…</p></main>');
  let d;
  try { d = await api.publicShelves.book(shelfId); } catch (err) {
    if (ctx.isCurrent(route)) ctx.mount(html`<main class="shell no-tabs"><header class="topbar"><a class="back" href="#/explore">← 둘러보기</a></header><p class="empty-line">${err.message}</p></main>`);
    return;
  }
  if (!ctx.isCurrent(route)) return;
  const b = d.item.book;
  const STATUS = { want: "읽고 싶은 책", reading: "읽는 중", finished: "다 읽음", stopped: "그만 읽음" };
  ctx.mount(html`
    <main class="shell no-tabs">
      <header class="topbar"><a class="back" href="#/shared/${d.owner.user_id}">← ${d.owner.display_name}님의 책장</a></header>
      <section class="book-head">
        ${raw(b.cover_url ? html`<img class="cover big" src="${b.cover_url}" alt="" referrerpolicy="no-referrer">` : '<span class="cover big cover-none" aria-hidden="true"></span>')}
        <div><h1>${b.title}</h1>
          <p class="book-by">${(b.authors || []).join(", ")}${b.publisher ? ` · ${b.publisher}` : ""}</p>
          <p class="note-meta">${d.owner.display_name} · ${STATUS[d.item.status] || ""}${d.total_minutes ? ` · 읽은 시간 ${minutesText(d.total_minutes)}` : ""}</p>
        </div>
      </section>
      <p class="hint">${d.owner.display_name}님이 공개한 기록이에요. 보기만 할 수 있어요.</p>
      <section class="block">
        <h2>메모 <span class="count">${d.notes.length}</span></h2>
        ${raw(d.notes.length ? html`<ul class="shared-notes">${d.notes.map((n) => raw(html`<li>
            <p class="note-meta">${n.page !== null && n.page !== undefined ? `${n.page}쪽 · ` : ""}${KIND[n.kind] || "메모"} · ${formatDate(n.created_at)}</p>
            <p class="note-body reading">${n.body}</p>
            ${raw(n.thought ? html`<blockquote class="note-thought-full"><span>${d.owner.display_name}님의 생각</span>${n.thought}</blockquote>` : "")}
            ${raw(n.photo_url ? html`<figure class="kept-photo"><img src="${n.photo_url}" alt="남긴 사진" loading="lazy" referrerpolicy="no-referrer"></figure>` : "")}
          </li>`))}</ul>` : '<p class="empty-line">남긴 메모가 없어요.</p>')}
      </section>
      ${raw(d.logs.length ? html`<section class="block">
        <h2>독서 시간 <span class="count">모두 ${minutesText(d.total_minutes)}</span></h2>
        <ul class="log-list">${d.logs.map((l) => raw(html`<li><span class="log-row">
          <span class="log-day">${dayText(l.read_on)}</span><span class="log-min">${minutesText(l.minutes)}</span>
          <span class="log-page">${l.end_page ? `${l.end_page}쪽까지` : ""}</span>
          <span class="log-how">${l.method === "timer" ? "타이머" : "적음"}</span></span></li>`))}</ul>
      </section>` : "")}
    </main>`);
}
