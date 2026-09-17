// 화면 도우미: 글자 안전 처리, 알림, 확인 창, 단추 잠그기

const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ESC[c]);

/** 태그된 템플릿: ${} 안의 값은 모두 안전하게 바꿔 넣는다. raw() 로 감싼 것만 그대로 */
export function html(strings, ...values) {
  return strings.reduce((out, s, i) => {
    if (i === 0) return s;
    const v = values[i - 1];
    const piece = v && v.__raw ? v.value : Array.isArray(v) ? v.map((x) => (x && x.__raw ? x.value : esc(x))).join("") : esc(v);
    return out + piece + s;
  }, "");
}
export const raw = (value) => ({ __raw: true, value });

let toastTimer;
export function toast(message) {
  const el = document.getElementById("toast");
  el.textContent = message;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 2800);
}

/** 확인 창. 확인 누르면 true */
export function confirmBox({ title, body, ok = "확인", cancel = "취소", danger = false }) {
  const dlg = document.getElementById("dialog");
  dlg.innerHTML = html`
    <h2>${title}</h2>
    <p>${body}</p>
    <div class="actions">
      <button class="btn btn-quiet btn-small" value="cancel">${cancel}</button>
      <button class="btn ${danger ? "btn-warn" : "btn-primary"} btn-small" value="ok">${ok}</button>
    </div>`;
  return new Promise((resolve) => {
    dlg.querySelectorAll("button").forEach((b) =>
      b.addEventListener("click", () => { dlg.close(b.value); }));
    dlg.addEventListener("close", () => resolve(dlg.returnValue === "ok"), { once: true });
    dlg.showModal();
    dlg.querySelector('button[value="cancel"]').focus();
  });
}

/** 한 번만 보여 주는 값 (임시 비밀번호) */
export function secretBox({ title, body, secret }) {
  const dlg = document.getElementById("dialog");
  dlg.innerHTML = html`
    <h2>${title}</h2>
    <p>${body}</p>
    <code class="secret">${secret}</code>
    <div class="actions">
      <button class="btn btn-quiet btn-small" data-copy>복사</button>
      <button class="btn btn-primary btn-small" value="ok">닫기</button>
    </div>`;
  dlg.querySelector("[data-copy]").addEventListener("click", async (e) => {
    try { await navigator.clipboard.writeText(secret); e.target.textContent = "복사했어요"; }
    catch { e.target.textContent = "길게 눌러 복사해 주세요"; }
  });
  dlg.querySelector('button[value="ok"]').addEventListener("click", () => dlg.close());
  dlg.showModal();
}

/** 단추를 누르는 동안 잠그기 */
export async function busy(button, work) {
  if (button.getAttribute("aria-busy") === "true") return;
  const label = button.textContent;
  button.setAttribute("aria-busy", "true");
  button.disabled = true;
  try {
    return await work();
  } finally {
    button.removeAttribute("aria-busy");
    button.disabled = false;
    button.textContent = label;
  }
}

export function formatDate(iso) {
  const d = new Date(iso);
  return `${d.getFullYear()}. ${d.getMonth() + 1}. ${d.getDate()}.`;
}
