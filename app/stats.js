// book-log 5단계 화면: 통계 (달별 권수 · 시간 · 하루 평균 · 이어서 읽은 날 · 달력 · 다 읽은 책 · 읽는 중)
import { api } from "./api.js";
import { html, raw } from "./ui.js";
import { minutesText } from "./reading.js";

const WEEK = ["일", "월", "화", "수", "목", "금", "토"];
const kstToday = () => new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
const thisMonth = () => kstToday().slice(0, 7);

function shiftMonth(m, by) {
  const [y, mo] = m.split("-").map(Number);
  const d = new Date(Date.UTC(y, mo - 1 + by, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}
const monthText = (m) => `${Number(m.slice(0, 4))}년 ${Number(m.slice(5, 7))}월`;

/** 달력: 그 달 1일의 요일부터 채우고, 읽은 분에 따라 4단계로 진하게 */
function calendarHtml(month, days, calendar, today) {
  const [y, mo] = month.split("-").map(Number);
  const first = new Date(Date.UTC(y, mo - 1, 1)).getUTCDay();
  const max = Math.max(60, ...Object.values(calendar));
  const cells = [];
  for (let i = 0; i < first; i++) cells.push('<li class="cal-cell empty" aria-hidden="true"></li>');
  for (let d = 1; d <= days; d++) {
    const iso = `${month}-${String(d).padStart(2, "0")}`;
    const m = calendar[iso] ?? 0;
    const level = m === 0 ? 0 : Math.min(4, Math.ceil((m / max) * 4));
    cells.push(html`<li class="cal-cell level-${level} ${iso === today ? "today" : ""}">
      <span class="cal-day">${d}</span>
      <span class="visually-hidden">${m ? `${minutesText(m)} 읽음` : "기록 없음"}</span></li>`);
  }
  return html`<ul class="calendar" aria-label="${monthText(month)} 달력">
    ${WEEK.map((w) => raw(html`<li class="cal-head" aria-hidden="true">${w}</li>`))}
    ${cells.map((c) => raw(c))}
  </ul>`;
}

function bigNumbers(s) {
  const cards = [
    { n: `${s.books_finished}`, unit: "권", label: "다 읽은 책" },
    { n: `${s.books_read}`, unit: "권", label: "조금이라도 읽은 책" },
    { n: minutesText(s.total_minutes), unit: "", label: "읽은 시간" },
    { n: minutesText(s.average_minutes), unit: "", label: `하루 평균 (${s.average_over}일 기준)` },
  ];
  return html`<ul class="stat-cards">${cards.map((c) => raw(html`<li>
    <span class="stat-n">${c.n}<small>${c.unit}</small></span>
    <span class="stat-label">${c.label}</span></li>`))}</ul>`;
}

export async function viewStats(ctx, month) {
  const m = /^\d{4}-\d{2}$/.test(month || "") ? month : thisMonth();
  const route = month ? `stats/${month}` : "stats";
  const shell = (body) => ctx.mount(html`
    <main class="shell">
      <header class="topbar"><h1>통계</h1>${raw(ctx.meButton())}</header>
      ${raw(body)}
    </main>
    ${raw(ctx.tabbar("stats"))}`);
  shell('<p class="empty-line">불러오는 중…</p>');
  let s;
  try { ({ ...s } = await api.stats.get(m)); } catch (err) {
    if (ctx.isCurrent(route)) shell(html`<p class="empty-line">${err.message}</p>`);
    return;
  }
  if (!ctx.isCurrent(route)) return;
  const isNow = m === thisMonth();
  shell(html`
    <div class="month-nav">
      <a class="month-arrow" href="#/stats/${shiftMonth(m, -1)}" aria-label="앞 달">◀</a>
      <h2>${monthText(m)}</h2>
      ${raw(isNow ? '<span class="month-arrow is-off" aria-hidden="true">▶</span>'
        : html`<a class="month-arrow" href="#/stats/${shiftMonth(m, 1)}" aria-label="다음 달">▶</a>`)}
    </div>
    ${raw(bigNumbers(s))}
    <section class="block streak-row">
      <p class="streak-big">${s.streak}<small>일째</small></p>
      <div>
        <p class="streak-what">이어서 읽은 날</p>
        <p class="hint">가장 길었던 기록 ${s.best_streak}일 · 이 달에 읽은 날 ${s.read_days}일${s.longest_minutes ? ` · 한 번에 가장 오래 ${minutesText(s.longest_minutes)}` : ""}</p>
      </div>
    </section>
    <section class="block">
      <h2>달력</h2>
      ${raw(calendarHtml(m, s.days, s.calendar, s.today))}
      <p class="hint">읽은 시간이 많은 날일수록 진하게 칠해요.</p>
    </section>
    <section class="block">
      <h2>다 읽은 책 <span class="count">${s.finished.length}</span></h2>
      ${raw(s.finished.length
        ? html`<ul class="cover-grid">${s.finished.map((x) => raw(html`<li><a href="#/book/${x.id}">
            ${raw(x.book.cover_url ? html`<img src="${x.book.cover_url}" alt="" loading="lazy" referrerpolicy="no-referrer">`
              : html`<span class="cover-none">${x.book.title}</span>`)}
            <span class="cover-title">${x.book.title}</span></a></li>`))}</ul>`
        : '<p class="empty-line">이 달에 다 읽은 책이 아직 없어요.</p>')}
    </section>
    <section class="block">
      <h2>읽는 중인 책 <span class="count">${s.reading.length}</span></h2>
      ${raw(s.reading.length
        ? html`<ul class="note-list">${s.reading.map((x) => raw(html`<li><a class="note-row" href="#/book/${x.id}">
            <span class="note-text">${x.book.title}</span>
            <span class="note-meta">${x.total_pages && x.current_page ? `${x.current_page} / ${x.total_pages}쪽` : x.current_page ? `${x.current_page}쪽까지` : "아직 기록 없음"}</span></a></li>`))}</ul>`
        : '<p class="empty-line">읽는 중인 책이 없어요.</p>')}
    </section>
    <p class="hint center">이 달에 남긴 메모 ${s.note_count}개</p>`);
}
