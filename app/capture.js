// book-log 3단계 화면: 문장 찍기
//   사진 → 네 귀퉁이 맞추기 → [펴기] → 자르기 · 돌리기 → [글자 읽기] → 고치기 → 밑줄 → 저장
// · 사진 펴기(원근 보정)는 외부 도구 없이 이 폰 안에서 계산한다 (보안 규칙상 외부 스크립트 불가)
// · 단계마다 주소가 바뀌어(#/capture/<책>/<단계>) 폰의 뒤로 가기로 앞 단계에 돌아갈 수 있다
// · 만들던 메모(draft)는 이 화면 안에만 있다. 저장하거나 새 사진을 고르면 비운다
import { api } from "./api.js";
import { busy, confirmBox, html, raw, toast } from "./ui.js";
import { markedBody, mountPicker, placeHighlights } from "./notes.js";

const STEPS = ["pick", "corners", "crop", "edit", "underline", "save"];
const STEP_LABEL = { pick: "사진", corners: "귀퉁이", crop: "자르기", edit: "고치기", underline: "밑줄", save: "저장" };
const SRC_MAX = 2400;    // 사진을 열 때 긴 쪽 최대 (폰 메모리 아끼기)
const FLAT_MAX = 2000;   // 편 사진 긴 쪽 최대
const OCR_MAX = 2000;    // 글자 읽기로 보내는 사진 긴 쪽 최대
const PHOTO_MAX = 1600;  // 남기는 사진 긴 쪽 최대 (약 0.3MB)
const HANDLE_NAMES = ["왼쪽 위", "오른쪽 위", "오른쪽 아래", "왼쪽 아래"];

let draft = null;
let fromBook = null;       // 책 화면의 [문장 찍기]로 들어왔으면 그 책 번호 (저장 뒤 책 화면으로 되돌아가기)
const lastPage = new Map(); // 책마다 마지막에 적은 쪽수
let cleanups = [];

export function markFromBook(shelfId) { fromBook = shelfId; }
export function leaveCapture() {
  cleanups.forEach((f) => { try { f(); } catch { /* 무시 */ } });
  cleanups = [];
}
export function resetCapture() { leaveCapture(); clearDraft(); fromBook = null; lastPage.clear(); }
function clearDraft() {
  if (draft?.imageUrl) URL.revokeObjectURL(draft.imageUrl);
  draft = null;
}

// ── 글자 도우미 ────────────────────────────────────────────
/** 서버와 똑같이 정리 (밑줄 위치가 어긋나지 않게) */
export function normalizeText(t) {
  return String(t || "").replace(/\r\n?/g, "\n").replace(/[ \t]+$/gm, "").trim();
}

/** 책 줄 끝에서 끊긴 줄 이어 붙이기. 문장이 끝나고 줄이 짧으면(문단 끝) 줄바꿈을 남긴다 */
export function joinLines(text) {
  const lines = String(text || "").replace(/\r/g, "").split("\n");
  const lens = lines.map((l) => l.trim().length).filter((n) => n > 0).sort((a, b) => a - b);
  const median = lens.length ? lens[Math.floor(lens.length / 2)] : 0;
  let out = "";
  lines.forEach((line, i) => {
    const cur = line.trim();
    if (i === 0) { out = cur; return; }
    const prev = lines[i - 1].trim();
    if (!cur || !prev) { out += "\n" + cur; return; }
    if (/[.!?。”"’』」)\]…]$/.test(prev) && prev.length < median * 0.8) { out += "\n" + cur; return; }
    if (/[A-Za-z]-$/.test(prev) && /^[a-z]/.test(cur)) { out = out.slice(0, -1) + cur; return; }
    out += " " + cur;
  });
  return out.replace(/\n{3,}/g, "\n\n").trim();
}

// ── 사진 도우미 ────────────────────────────────────────────
function makeCanvas(w, h) {
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

async function loadImage(file) {
  if (file.type && !file.type.startsWith("image/")) throw new Error("사진 파일이 아니에요. 사진을 골라 주세요.");
  let source;
  let w;
  let h;
  try {
    source = await createImageBitmap(file, { imageOrientation: "from-image" });
    w = source.width; h = source.height;
  } catch {
    // createImageBitmap 이 없거나 실패하면 <img> 로 한 번 더
    const url = URL.createObjectURL(file);
    try {
      source = await new Promise((ok, no) => { const im = new Image(); im.onload = () => ok(im); im.onerror = no; im.src = url; });
      w = source.naturalWidth; h = source.naturalHeight;
    } catch {
      throw new Error("이 사진은 열 수 없어요. JPG나 PNG 사진으로 다시 골라 주세요.");
    } finally { URL.revokeObjectURL(url); }
  }
  if (!w || !h) throw new Error("이 사진은 열 수 없어요. 다른 사진을 골라 주세요.");
  const k = Math.min(1, SRC_MAX / Math.max(w, h));
  const c = makeCanvas(w * k, h * k);
  const g = c.getContext("2d");
  g.fillStyle = "#fff";
  g.fillRect(0, 0, c.width, c.height);
  g.imageSmoothingQuality = "high";
  g.drawImage(source, 0, 0, c.width, c.height);
  if (source.close) source.close();
  return c;
}

/** 네 점을 왼쪽 위부터 시계 방향으로 */
function orderQuad(pts) {
  const cx = pts.reduce((s, p) => s + p[0], 0) / 4;
  const cy = pts.reduce((s, p) => s + p[1], 0) / 4;
  const sorted = pts.map((p) => [p[0], p[1]]).sort((a, b) => Math.atan2(a[1] - cy, a[0] - cx) - Math.atan2(b[1] - cy, b[0] - cx));
  let first = 0;
  sorted.forEach((p, i) => { if (p[0] + p[1] < sorted[first][0] + sorted[first][1]) first = i; });
  return sorted.slice(first).concat(sorted.slice(0, first));
}

function isConvex(q) {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const [ax, ay] = q[i];
    const [bx, by] = q[(i + 1) % 4];
    const [cx, cy] = q[(i + 2) % 4];
    const cross = (bx - ax) * (cy - by) - (by - ay) * (cx - bx);
    if (Math.abs(cross) < 1) return false;
    if (sign && Math.sign(cross) !== sign) return false;
    sign = Math.sign(cross);
    if (Math.hypot(bx - ax, by - ay) < 20) return false;
  }
  return true;
}

/** 8원 연립방정식 (가우스 소거) */
function solve(A, b) {
  const n = b.length;
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    [A[c], A[p]] = [A[p], A[c]];
    [b[c], b[p]] = [b[p], b[c]];
    const d = A[c][c];
    if (Math.abs(d) < 1e-12) throw new Error("singular");
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = A[r][c] / d;
      if (!f) continue;
      for (let k = c; k < n; k++) A[r][k] -= f * A[c][k];
      b[r] -= f * b[c];
    }
  }
  return b.map((v, i) => v / A[i][i]);
}

/** 원근 보정 계산: 반듯한 네모의 한 점 → 사진 속 비스듬한 점 */
export function homography(from, to) {
  const A = [];
  const b = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = from[i];
    const [u, v] = to[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
  }
  return solve(A, b);
}

/** 비스듬히 찍힌 페이지(네 점)를 정면에서 본 네모로 펴기 */
function warp(src, quad) {
  const d = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  let W = Math.max(d(quad[0], quad[1]), d(quad[3], quad[2]));
  let H = Math.max(d(quad[0], quad[3]), d(quad[1], quad[2]));
  const k = Math.min(1, FLAT_MAX / Math.max(W, H));
  W = Math.max(1, Math.round(W * k));
  H = Math.max(1, Math.round(H * k));
  const h = homography([[0, 0], [W, 0], [W, H], [0, H]], quad);
  const sw = src.width;
  const sh = src.height;
  const s = src.getContext("2d").getImageData(0, 0, sw, sh).data;
  const out = makeCanvas(W, H);
  const og = out.getContext("2d");
  const img = og.createImageData(W, H);
  const o = img.data;
  for (let y = 0; y < H; y++) {
    const yy = y + 0.5;
    for (let x = 0; x < W; x++) {
      const xx = x + 0.5;
      const den = h[6] * xx + h[7] * yy + 1;
      let u = (h[0] * xx + h[1] * yy + h[2]) / den - 0.5;
      let v = (h[3] * xx + h[4] * yy + h[5]) / den - 0.5;
      if (u < 0) u = 0; else if (u > sw - 1) u = sw - 1;
      if (v < 0) v = 0; else if (v > sh - 1) v = sh - 1;
      const x0 = u | 0;
      const y0 = v | 0;
      const x1 = x0 < sw - 1 ? x0 + 1 : x0;
      const y1 = y0 < sh - 1 ? y0 + 1 : y0;
      const fx = u - x0;
      const fy = v - y0;
      const i00 = (y0 * sw + x0) * 4;
      const i10 = (y0 * sw + x1) * 4;
      const i01 = (y1 * sw + x0) * 4;
      const i11 = (y1 * sw + x1) * 4;
      const j = (y * W + x) * 4;
      for (let c = 0; c < 3; c++) {
        const top = s[i00 + c] + (s[i10 + c] - s[i00 + c]) * fx;
        const bot = s[i01 + c] + (s[i11 + c] - s[i01 + c]) * fx;
        o[j + c] = top + (bot - top) * fy;
      }
      o[j + 3] = 255;
    }
  }
  og.putImageData(img, 0, 0);
  return out;
}

function rotate(src, dir) {
  const c = makeCanvas(src.height, src.width);
  const g = c.getContext("2d");
  g.translate(c.width / 2, c.height / 2);
  g.rotate((dir * Math.PI) / 2);
  g.drawImage(src, -src.width / 2, -src.height / 2);
  return c;
}

function cropped() {
  const q = draft.crop;
  const x0 = Math.max(0, Math.round(q[0][0]));
  const y0 = Math.max(0, Math.round(q[0][1]));
  const x1 = Math.min(draft.flat.width, Math.round(q[2][0]));
  const y1 = Math.min(draft.flat.height, Math.round(q[2][1]));
  const c = makeCanvas(x1 - x0, y1 - y0);
  c.getContext("2d").drawImage(draft.flat, x0, y0, c.width, c.height, 0, 0, c.width, c.height);
  return c;
}

async function toJpeg(src, max, qualities, maxBytes) {
  const k = Math.min(1, max / Math.max(src.width, src.height));
  let c = src;
  if (k < 1) {
    c = makeCanvas(src.width * k, src.height * k);
    const g = c.getContext("2d");
    g.imageSmoothingQuality = "high";
    g.drawImage(src, 0, 0, c.width, c.height);
  }
  let blob = null;
  for (const q of qualities) {
    blob = await new Promise((ok) => c.toBlob(ok, "image/jpeg", q));
    if (blob && blob.size <= maxBytes) break;
  }
  if (!blob) throw new Error("사진을 만들지 못했어요. 다시 해 주세요.");
  return blob;
}

function blobToBase64(blob) {
  return new Promise((ok, no) => {
    const r = new FileReader();
    r.onload = () => ok(String(r.result).split(",")[1] || "");
    r.onerror = () => no(new Error("사진을 읽지 못했어요. 다시 해 주세요."));
    r.readAsDataURL(blob);
  });
}

const nextFrame = () => new Promise((ok) => requestAnimationFrame(() => setTimeout(ok, 0)));

// ── 사진 위 동그라미 편집기 (네 귀퉁이 · 자르기 공용) ─────────────────
function stageHtml(label) {
  return html`<div class="stage-wrap"><div class="stage" id="stage" role="group" aria-label="${label}">
    <canvas class="stage-img" aria-hidden="true"></canvas>
    <svg class="stage-lines" aria-hidden="true"><path class="shade" fill-rule="evenodd"></path><polygon class="edge"></polygon></svg>
    ${HANDLE_NAMES.map((n, i) => raw(html`<button type="button" class="handle" data-h="${i}" aria-label="${n} 모서리 (화살표 키로 옮기기)"></button>`))}
    <canvas class="loupe" hidden aria-hidden="true"></canvas>
    <div class="stage-busy" hidden><span></span></div>
  </div></div>`;
}

function mountEditor(stage, src, pts, mode) {
  const img = stage.querySelector(".stage-img");
  const svg = stage.querySelector(".stage-lines");
  const shade = svg.querySelector(".shade");
  const edge = svg.querySelector(".edge");
  const handles = [...stage.querySelectorAll(".handle")];
  const loupe = stage.querySelector(".loupe");
  const L = 132;
  const MIN = 24;
  let scale = 1;
  let dw = 0;
  let dh = 0;
  const dpr = Math.min(2, window.devicePixelRatio || 1);

  const paint = () => {
    const d = pts.map(([x, y]) => [x * scale, y * scale]);
    edge.setAttribute("points", d.map((p) => p.join(",")).join(" "));
    shade.setAttribute("d", `M0 0H${dw}V${dh}H0Z M${d.map((p) => p.join(" ")).join(" L")}Z`);
    handles.forEach((h, i) => { h.style.left = `${d[i][0]}px`; h.style.top = `${d[i][1]}px`; });
  };
  const layout = () => {
    const maxW = stage.parentElement.clientWidth || 360;
    const maxH = Math.max(260, Math.round(window.innerHeight * 0.6));
    scale = Math.min(maxW / src.width, maxH / src.height);
    dw = Math.round(src.width * scale);
    dh = Math.round(src.height * scale);
    stage.style.width = `${dw}px`;
    stage.style.height = `${dh}px`;
    img.width = Math.round(dw * dpr);
    img.height = Math.round(dh * dpr);
    img.style.width = `${dw}px`;
    img.style.height = `${dh}px`;
    const g = img.getContext("2d");
    g.imageSmoothingQuality = "high";
    g.drawImage(src, 0, 0, img.width, img.height);
    svg.setAttribute("viewBox", `0 0 ${dw} ${dh}`);
    svg.setAttribute("width", dw);
    svg.setAttribute("height", dh);
    loupe.width = L * dpr;
    loupe.height = L * dpr;
    loupe.style.width = `${L}px`;
    loupe.style.height = `${L}px`;
    paint();
  };

  const setPoint = (i, x, y) => {
    x = Math.min(src.width, Math.max(0, x));
    y = Math.min(src.height, Math.max(0, y));
    if (mode === "rect") {
      const opp = pts[(i + 2) % 4];
      const left = i === 0 || i === 3;
      const top = i === 0 || i === 1;
      x = left ? Math.min(x, opp[0] - MIN) : Math.max(x, opp[0] + MIN);
      y = top ? Math.min(y, opp[1] - MIN) : Math.max(y, opp[1] + MIN);
      pts[i][0] = x; pts[i][1] = y;
      const sameX = left ? (i === 0 ? 3 : 0) : (i === 1 ? 2 : 1);
      const sameY = top ? (i === 0 ? 1 : 0) : (i === 2 ? 3 : 2);
      pts[sameX][0] = x;
      pts[sameY][1] = y;
    } else {
      pts[i][0] = x; pts[i][1] = y;
    }
  };

  const drawLoupe = (i, px, py) => {
    const [cx, cy] = pts[i];
    const side = L / scale / 3; // 화면보다 3배 크게
    const g = loupe.getContext("2d");
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = "#1D2939";
    g.fillRect(0, 0, L, L);
    g.imageSmoothingEnabled = true;
    g.drawImage(src, cx - side / 2, cy - side / 2, side, side, 0, 0, L, L);
    const toL = ([x, y]) => [((x - cx) / side) * L + L / 2, ((y - cy) / side) * L + L / 2];
    g.strokeStyle = "#D9A93A";
    g.lineWidth = 2;
    g.beginPath();
    const [ax, ay] = toL(pts[(i + 3) % 4]);
    const [bx, by] = toL(pts[(i + 1) % 4]);
    g.moveTo(ax, ay); g.lineTo(L / 2, L / 2); g.lineTo(bx, by);
    g.stroke();
    g.strokeStyle = "#fff";
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(L / 2 - 10, L / 2); g.lineTo(L / 2 + 10, L / 2);
    g.moveTo(L / 2, L / 2 - 10); g.lineTo(L / 2, L / 2 + 10);
    g.stroke();
    // 손가락에 가리지 않게: 위쪽, 자리가 없으면 옆쪽
    let lx = px - L / 2;
    let ly = py - L - 56;
    if (ly < -8) { ly = Math.min(dh - L, Math.max(0, py - L / 2)); lx = px < dw / 2 ? px + 56 : px - L - 56; }
    loupe.style.left = `${Math.min(dw - L, Math.max(0, lx))}px`;
    loupe.style.top = `${ly}px`;
    loupe.hidden = false;
  };

  let active = -1;
  let offset = [0, 0];
  const local = (e) => { const r = stage.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  stage.addEventListener("pointerdown", (e) => {
    if (stage.classList.contains("is-busy")) return;
    const [px, py] = local(e);
    let best = -1;
    let bd = Infinity;
    pts.forEach(([x, y], i) => { const dd = Math.hypot(x * scale - px, y * scale - py); if (dd < bd) { bd = dd; best = i; } });
    if (bd > 56) return;
    e.preventDefault();
    active = best;
    offset = [pts[best][0] * scale - px, pts[best][1] * scale - py];
    stage.setPointerCapture(e.pointerId);
    handles[best].classList.add("dragging");
    drawLoupe(best, pts[best][0] * scale, pts[best][1] * scale);
  });
  stage.addEventListener("pointermove", (e) => {
    if (active < 0) return;
    e.preventDefault();
    const [px, py] = local(e);
    setPoint(active, (px + offset[0]) / scale, (py + offset[1]) / scale);
    paint();
    drawLoupe(active, pts[active][0] * scale, pts[active][1] * scale);
  });
  const end = () => {
    if (active < 0) return;
    handles[active].classList.remove("dragging");
    active = -1;
    loupe.hidden = true;
  };
  stage.addEventListener("pointerup", end);
  stage.addEventListener("pointercancel", end);
  handles.forEach((h, i) => h.addEventListener("keydown", (e) => {
    const step = (e.shiftKey ? 20 : 3) / scale;
    const mv = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
    if (!mv) return;
    e.preventDefault();
    setPoint(i, pts[i][0] + mv[0], pts[i][1] + mv[1]);
    paint();
  }));

  layout();
  let t;
  const onResize = () => { clearTimeout(t); t = setTimeout(layout, 120); };
  window.addEventListener("resize", onResize);
  cleanups.push(() => window.removeEventListener("resize", onResize));
  return {
    busy(on, label = "") {
      stage.classList.toggle("is-busy", on);
      const b = stage.querySelector(".stage-busy");
      b.hidden = !on;
      b.querySelector("span").textContent = label;
    },
  };
}

// ── 화면 틀 ─────────────────────────────────────────────
function frame(step, title, help, body) {
  const idx = STEPS.indexOf(step);
  const bookTitle = draft?.book?.title || "";
  return html`
    <main class="shell no-tabs capture">
      <header class="topbar"><button class="back" type="button" data-cap-back>← ${idx === 0 ? bookTitle || "책" : "뒤로"}</button>
        ${raw(idx > 0 && bookTitle ? html`<span class="cap-book">${bookTitle}</span>` : "")}</header>
      <ol class="steps" aria-label="문장 찍기 순서">${STEPS.map((s, i) => raw(html`<li class="${i < idx ? "done" : ""}" ${raw(i === idx ? 'aria-current="step"' : "")}>${STEP_LABEL[s]}</li>`))}</ol>
      <h1 class="who">${title}</h1>
      ${raw(help ? html`<p class="cap-help">${help}</p>` : "")}
      ${raw(body)}
    </main>`;
}

function wireFrame(ctx, shelfId, step) {
  ctx.app.querySelector("[data-cap-back]").addEventListener("click", () => {
    if (step === "pick") {
      if (fromBook === shelfId) { fromBook = null; history.back(); } else ctx.go(`book/${shelfId}`);
    } else history.back();
  });
}

function goStep(ctx, shelfId, step) { ctx.go(`capture/${shelfId}/${step}`); }

// ── 길 찾기 ─────────────────────────────────────────────
export async function viewCapture(ctx, shelfId, step) {
  if (!shelfId) return ctx.go("shelf");
  if (!STEPS.includes(step)) return ctx.replace(`capture/${shelfId}/pick`);
  if (draft && draft.shelfId !== shelfId) clearDraft();
  const ready = {
    pick: true,
    corners: !!draft?.src,
    crop: !!draft?.flat,
    edit: typeof draft?.text === "string",
    underline: typeof draft?.text === "string",
    save: typeof draft?.text === "string",
  }[step];
  if (!ready) return ctx.replace(`capture/${shelfId}/pick`);
  if (step === "pick") return stepPick(ctx, shelfId);
  if (step === "corners") return stepCorners(ctx, shelfId);
  if (step === "crop") return stepCrop(ctx, shelfId);
  if (step === "edit") return stepEdit(ctx, shelfId);
  if (step === "underline") return stepUnderline(ctx, shelfId);
  return stepSave(ctx, shelfId);
}

// ── 1. 사진 고르기 ─────────────────────────────────────────
async function stepPick(ctx, shelfId) {
  const route = `capture/${shelfId}/pick`;
  let book = draft?.book;
  if (!book) {
    ctx.mount('<main class="shell no-tabs"><p class="empty-line">불러오는 중…</p></main>');
    try { ({ item: { book } } = await api.shelf.get(shelfId)); }
    catch (err) {
      if (ctx.isCurrent(route)) ctx.mount(html`<main class="shell no-tabs"><header class="topbar"><a class="back" href="#/shelf">← 서재</a></header><p class="empty-line">${err.message}</p></main>`);
      return;
    }
    if (!ctx.isCurrent(route)) return;
  }
  const coarse = matchMedia("(pointer: coarse)").matches;
  const ways = coarse
    ? html`<label class="btn btn-primary btn-block file-btn">카메라로 찍기<input class="file-input" type="file" accept="image/*" capture="environment" data-file></label>
       <label class="btn btn-quiet btn-block file-btn">사진첩에서 고르기<input class="file-input" type="file" accept="image/*" data-file></label>`
    : html`<label class="btn btn-primary btn-block file-btn">사진 파일 올리기<input class="file-input" type="file" accept="image/*" data-file></label>
       <p class="hint drop-hint">사진 파일을 이 화면에 끌어다 놓아도 돼요.</p>`;
  ctx.mount(frame("pick", "문장 찍기", "마음에 남은 쪽을 찍으면 글자로 바꿔 드려요.", html`
    <div class="pick-ways">${raw(ways)}
      ${raw(draft?.src ? '<button class="btn btn-quiet btn-block" type="button" id="continue">방금 고른 사진으로 계속</button>' : "")}
    </div>
    <p class="scan-help" id="pick-status" role="status"></p>
    <ul class="tips">
      <li>책을 반듯하게 펴고, 그림자가 지지 않게 밝은 곳에서 찍어요.</li>
      <li>읽을 부분이 화면에 크게 나오게 가까이 찍어요.</li>
      <li>조금 비스듬해도 괜찮아요. 다음 단계에서 반듯하게 펴 드려요.</li>
    </ul>`));
  wireFrame(ctx, shelfId, "pick");
  const status = ctx.app.querySelector("#pick-status");
  const open = async (file) => {
    if (!file) return;
    status.textContent = "사진을 여는 중…";
    try {
      const src = await loadImage(file);
      if (!ctx.isCurrent(route)) return;
      clearDraft();
      const ix = src.width * 0.06;
      const iy = src.height * 0.06;
      draft = {
        shelfId, book, src,
        quad: [[ix, iy], [src.width - ix, iy], [src.width - ix, src.height - iy], [ix, src.height - iy]],
        flat: null, crop: null, text: null, ocrText: null, highlights: [], undo: [], shot: null, imageUrl: null,
      };
      goStep(ctx, shelfId, "corners");
    } catch (err) { status.textContent = err.message; }
  };
  ctx.app.querySelectorAll("[data-file]").forEach((input) => input.addEventListener("change", () => open(input.files[0])));
  ctx.app.querySelector("#continue")?.addEventListener("click", () => goStep(ctx, shelfId, "corners"));
  const main = ctx.app.querySelector("main");
  main.addEventListener("dragover", (e) => { e.preventDefault(); main.classList.add("is-drop"); });
  main.addEventListener("dragleave", () => main.classList.remove("is-drop"));
  main.addEventListener("drop", (e) => { e.preventDefault(); main.classList.remove("is-drop"); open(e.dataTransfer.files[0]); });
}

// ── 2. 네 귀퉁이 맞추기 · 펴기 ────────────────────────────────
function stepCorners(ctx, shelfId) {
  ctx.mount(frame("corners", "네 귀퉁이 맞추기", "동그라미를 끌어 책 페이지의 네 모서리에 맞춘 뒤 [펴기]를 누르세요.", html`
    ${raw(stageHtml("페이지 네 모서리"))}
    <p class="scan-help" id="cap-status" role="status"></p>
    <div class="row-actions">
      <button class="btn btn-primary grow" type="button" id="flatten">펴기</button>
      <button class="btn btn-quiet" type="button" id="skip">펴지 않고 넘어가기</button>
    </div>`));
  wireFrame(ctx, shelfId, "corners");
  const editor = mountEditor(ctx.app.querySelector("#stage"), draft.src, draft.quad, "quad");
  const status = ctx.app.querySelector("#cap-status");
  ctx.app.querySelector("#flatten").addEventListener("click", (e) => busy(e.currentTarget, async () => {
    const q = orderQuad(draft.quad);
    if (!isConvex(q)) {
      status.textContent = "동그라미 네 개가 페이지 모서리를 둘러싸도록 놓아 주세요.";
      return;
    }
    editor.busy(true, "펴는 중…");
    status.textContent = "";
    await nextFrame();
    try {
      draft.flat = warp(draft.src, q);
      draft.crop = null;
      goStep(ctx, shelfId, "crop");
    } catch {
      editor.busy(false);
      status.textContent = "사진을 펴지 못했어요. 동그라미 위치를 바꿔 다시 눌러 주세요.";
    }
  }));
  ctx.app.querySelector("#skip").addEventListener("click", () => {
    draft.flat = draft.src;
    draft.crop = null;
    goStep(ctx, shelfId, "crop");
  });
}

// ── 3. 자르기 · 돌리기 · 글자 읽기 ──────────────────────────────
function stepCrop(ctx, shelfId) {
  const f = draft.flat;
  if (!draft.crop) draft.crop = [[0, 0], [f.width, 0], [f.width, f.height], [0, f.height]];
  ctx.mount(frame("crop", "자르기 · 돌리기", "읽을 부분만 남기면 글자를 더 잘 읽어요.", html`
    ${raw(stageHtml("남길 부분"))}
    <div class="row-actions">
      <button class="btn btn-quiet btn-small" type="button" data-rot="-1">↺ 왼쪽으로 돌리기</button>
      <button class="btn btn-quiet btn-small" type="button" data-rot="1">↻ 오른쪽으로 돌리기</button>
    </div>
    <div class="cap-error" id="ocr-error" hidden>
      <p role="alert" id="ocr-error-text"></p>
      <div class="row-actions">
        <button class="btn btn-primary btn-small" type="button" id="retry">다시 시도</button>
        <button class="btn btn-quiet btn-small" type="button" data-manual>직접 입력</button>
      </div>
    </div>
    <button class="btn btn-primary btn-block" type="button" id="read">글자 읽기</button>
    <p class="quota" id="quota" role="status"></p>
    <button class="btn btn-quiet btn-block" type="button" data-manual>글자 읽지 않고 직접 입력</button>`));
  wireFrame(ctx, shelfId, "crop");
  const route = `capture/${shelfId}/crop`;
  const editor = mountEditor(ctx.app.querySelector("#stage"), draft.flat, draft.crop, "rect");
  const readBtn = ctx.app.querySelector("#read");
  const quota = ctx.app.querySelector("#quota");
  const errBox = ctx.app.querySelector("#ocr-error");
  const showQuota = (used, limit) => {
    quota.textContent = `오늘 글자 읽기 ${used} / ${limit}번`;
    readBtn.disabled = used >= limit;
    if (used >= limit) quota.textContent += " — 오늘은 다 썼어요. [직접 입력]으로 적을 수 있어요.";
  };
  api.ocr.quota().then((r) => {
    if (typeof r.keep_photo === "boolean") ctx.state.user.keep_photo = r.keep_photo; // 다른 기기에서 바꾼 기억값
    if (ctx.isCurrent(route)) showQuota(r.used, r.limit);
  }).catch(() => { /* 읽기를 누르면 서버가 다시 알려 줌 */ });

  ctx.app.querySelectorAll("[data-rot]").forEach((b) => b.addEventListener("click", () => {
    draft.flat = rotate(draft.flat, Number(b.dataset.rot));
    draft.crop = null;
    stepCrop(ctx, shelfId);
  }));

  const makeShot = async () => {
    draft.shot = cropped();
    const blob = await toJpeg(draft.shot, OCR_MAX, [0.85, 0.72, 0.6], 1400000);
    if (draft.imageUrl) URL.revokeObjectURL(draft.imageUrl);
    draft.imageUrl = URL.createObjectURL(blob);
    return blob;
  };

  const read = (button) => busy(button, async () => {
    const edited = typeof draft.text === "string" && draft.text !== draft.ocrText;
    if (edited && !(await confirmBox({ title: "글자를 새로 읽을까요?", body: "고친 글자와 그은 밑줄이 새로 읽은 글자로 바뀌어요. 1번으로 셉니다.", ok: "새로 읽기" }))) return;
    errBox.hidden = true;
    editor.busy(true, "글자를 읽는 중…");
    try {
      const blob = await makeShot();
      const { text, used, limit } = await api.ocr.read(await blobToBase64(blob));
      if (!ctx.isCurrent(route)) return;
      draft.text = normalizeText(text);
      draft.ocrText = draft.text;
      draft.highlights = [];
      draft.undo = [];
      showQuota(used, limit);
      goStep(ctx, shelfId, "edit");
    } catch (err) {
      if (!ctx.isCurrent(route)) return;
      editor.busy(false);
      ctx.app.querySelector("#ocr-error-text").textContent = err.message;
      ctx.app.querySelector("#retry").hidden = err.code === "OCR_LIMIT" || err.code === "NO_VISION_KEY";
      errBox.hidden = false;
      errBox.scrollIntoView({ block: "nearest", behavior: "smooth" });
      if (err.code === "OCR_LIMIT") readBtn.disabled = true;
      api.ocr.quota().then((r) => { if (ctx.isCurrent(route)) showQuota(r.used, r.limit); }).catch(() => {});
    }
  });
  readBtn.addEventListener("click", () => read(readBtn));
  ctx.app.querySelector("#retry").addEventListener("click", (e) => read(e.currentTarget));
  ctx.app.querySelectorAll("[data-manual]").forEach((b) => b.addEventListener("click", () => busy(b, async () => {
    await makeShot();
    if (typeof draft.text !== "string") { draft.text = ""; draft.ocrText = ""; }
    goStep(ctx, shelfId, "edit");
  })));
}

// ── 4. 글자 고치기 ─────────────────────────────────────────
function gapsHtml(text) {
  let out = "";
  let at = 0;
  const re = /\s+/g;
  let m;
  while ((m = re.exec(text))) {
    if (m.index > at) out += html`<span class="t">${text.slice(at, m.index)}</span>`;
    const nl = m[0].includes("\n");
    out += html`<button type="button" class="gap ${nl ? "gap-nl" : ""}" data-s="${m.index}" data-e="${m.index + m[0].length}" aria-label="${nl ? "이 줄바꿈 없애기" : "이 공백 없애기"}"></button>${raw(nl ? "<br>" : "")}`;
    at = m.index + m[0].length;
  }
  out += html`<span class="t">${text.slice(at)}</span>`;
  return out;
}

function stepEdit(ctx, shelfId) {
  ctx.mount(frame("edit", "글자 고치기", "사진과 비교하며 틀린 글자를 고쳐 주세요.", html`
    <figure class="shot-view">
      <div class="shot-scroll" id="shot-scroll">${raw(draft.imageUrl ? html`<img id="peek-img" src="${draft.imageUrl}" alt="찍은 페이지">` : "")}</div>
      ${raw(draft.imageUrl ? '<button class="zoom-btn" type="button" id="zoom">크게</button>' : "")}
    </figure>
    <div class="tools" role="toolbar" aria-label="글자 고치기 도구">
      <button class="btn btn-quiet btn-small" type="button" id="join">줄 이어 붙이기</button>
      <button class="btn btn-quiet btn-small" type="button" id="gaps" aria-pressed="false">공백 없애기</button>
      <button class="btn btn-quiet btn-small" type="button" id="undo" disabled>되돌리기</button>
    </div>
    <label class="visually-hidden" for="cap-text">찍은 문장</label>
    <textarea id="cap-text" class="cap-text" rows="10" placeholder="${draft.ocrText ? "" : "책의 문장을 적어 주세요."}"></textarea>
    <div class="reader gaps-view" id="gaps-view" hidden></div>
    <p class="hint" id="gaps-help" hidden>없앨 공백(점)이나 줄바꿈(↵)을 누르세요. 다 했으면 [공백 없애기]를 한 번 더 누르세요.</p>
    <p class="hint" id="count"></p>
    <button class="btn btn-primary btn-block" type="button" id="next">다음: 밑줄 긋기</button>`));
  wireFrame(ctx, shelfId, "edit");
  const $ = (s) => ctx.app.querySelector(s);
  const ta = $("#cap-text");
  const gapsView = $("#gaps-view");
  const gapsBtn = $("#gaps");
  const undoBtn = $("#undo");
  ta.value = draft.text;
  const sync = () => {
    $("#count").textContent = `${draft.text.length}자`;
    undoBtn.disabled = !draft.undo.length;
  };
  const change = (next) => {
    if (next === draft.text) return;
    draft.undo.push(draft.text);
    if (draft.undo.length > 50) draft.undo.shift();
    draft.text = next;
    ta.value = next;
    if (!gapsView.hidden) { const y = gapsView.scrollTop; gapsView.innerHTML = gapsHtml(next); gapsView.scrollTop = y; }
    sync();
  };
  sync();
  ta.addEventListener("input", () => { draft.text = ta.value; sync(); });
  $("#join").addEventListener("click", () => {
    const next = joinLines(draft.text);
    if (next === draft.text) toast("이어 붙일 줄이 없어요.");
    else { change(next); toast("줄을 이어 붙였어요. 되돌리려면 [되돌리기]를 누르세요."); }
  });
  gapsBtn.addEventListener("click", () => {
    const on = gapsBtn.getAttribute("aria-pressed") !== "true";
    gapsBtn.setAttribute("aria-pressed", String(on));
    gapsView.hidden = !on;
    $("#gaps-help").hidden = !on;
    ta.hidden = on;
    if (on) gapsView.innerHTML = gapsHtml(draft.text);
    else ta.focus();
  });
  gapsView.addEventListener("click", (e) => {
    const g = e.target.closest("button.gap");
    if (!g) return;
    const s = Number(g.dataset.s);
    const en = Number(g.dataset.e);
    change(draft.text.slice(0, s) + draft.text.slice(en));
  });
  undoBtn.addEventListener("click", () => {
    if (!draft.undo.length) return;
    draft.text = draft.undo.pop();
    ta.value = draft.text;
    if (!gapsView.hidden) gapsView.innerHTML = gapsHtml(draft.text);
    sync();
  });
  const zoom = $("#zoom");
  if (zoom) {
    const levels = [1, 2, 3];
    let z = 0;
    zoom.addEventListener("click", () => {
      z = (z + 1) % levels.length;
      $("#peek-img").style.width = `${levels[z] * 100}%`;
      zoom.textContent = z === levels.length - 1 ? "작게" : "크게";
      zoom.setAttribute("aria-label", z === levels.length - 1 ? "사진 원래 크기로" : "사진 더 크게");
    });
  }
  $("#next").addEventListener("click", () => {
    draft.text = normalizeText(draft.text);
    goStep(ctx, shelfId, "underline");
  });
}

// ── 5. 밑줄 긋기 ─────────────────────────────────────────
function stepUnderline(ctx, shelfId) {
  // 글을 고쳤다면 밑줄 자리를 다시 찾고, 못 찾은 밑줄은 뺀다
  const { placed, unplaced } = placeHighlights(draft.text, draft.highlights);
  draft.highlights = placed.map(({ s, e }) => ({ start: s, end: e, text: draft.text.slice(s, e) }));
  ctx.mount(frame("underline", "밑줄 긋기", "밑줄 시작 단어와 끝 단어를 차례로 누른 뒤 [밑줄 저장]을 누르세요. 여러 개 그을 수 있어요.", html`
    <p class="pick-help" id="pick-help" role="status">밑줄 시작 단어를 누르세요.</p>
    <div class="reader" id="picker"></div>
    <div class="row-actions">
      <button class="btn btn-primary" type="button" id="hl-add" disabled>밑줄 저장</button>
      <button class="btn btn-quiet" type="button" id="hl-clear" disabled>고르기 취소</button>
    </div>
    <section class="block">
      <h2>그은 밑줄 <span class="count" id="hl-count"></span></h2>
      <ul class="hl-list" id="hl-list"></ul>
    </section>
    <button class="btn btn-primary btn-block" type="button" id="next">다음: 저장하기</button>`));
  wireFrame(ctx, shelfId, "underline");
  if (unplaced.length) toast(`글을 고쳐서 밑줄 ${unplaced.length}개가 빠졌어요.`);
  const $ = (s) => ctx.app.querySelector(s);
  const help = $("#pick-help");
  let range = null;
  const picker = mountPicker($("#picker"), {
    getText: () => draft.text,
    getRanges: () => draft.highlights.map((h) => ({ s: h.start, e: h.end })),
    onPick: (r, first) => {
      range = r;
      $("#hl-add").disabled = !r;
      $("#hl-clear").disabled = !r && !first;
      help.textContent = r ? "고른 곳이 색칠됐어요. [밑줄 저장]을 누르세요."
        : first ? `「${first}」부터 — 끝 단어를 누르세요.` : "밑줄 시작 단어를 누르세요.";
    },
  });
  const list = () => {
    $("#hl-count").textContent = draft.highlights.length ? String(draft.highlights.length) : "";
    $("#hl-list").innerHTML = draft.highlights.length
      ? draft.highlights.map((h, i) => html`<li class="hl-item"><span class="hl-text">${h.text}</span><button class="link-btn" type="button" data-del="${i}">지우기</button></li>`).join("")
      : '<li class="empty-line">아직 그은 밑줄이 없어요. 밑줄 없이 저장해도 돼요.</li>';
    $("#hl-list").querySelectorAll("[data-del]").forEach((b) => b.addEventListener("click", () => {
      draft.highlights.splice(Number(b.dataset.del), 1);
      picker.redraw();
      list();
    }));
  };
  list();
  $("#hl-add").addEventListener("click", () => {
    if (!range) return;
    if (draft.highlights.some((h) => h.start === range.start && h.end === range.end)) { toast("이미 그은 밑줄이에요."); picker.reset(); return; }
    if (draft.highlights.length >= 50) { toast("한 메모에는 밑줄을 50개까지 그을 수 있어요."); return; }
    draft.highlights.push({ start: range.start, end: range.end, text: draft.text.slice(range.start, range.end) });
    draft.highlights.sort((a, b) => a.start - b.start);
    picker.reset();
    list();
    toast("밑줄을 그었어요.");
  });
  $("#hl-clear").addEventListener("click", () => picker.reset());
  $("#next").addEventListener("click", () => goStep(ctx, shelfId, "save"));
}

// ── 6. 저장 ─────────────────────────────────────────────
function stepSave(ctx, shelfId) {
  const keep = !!ctx.state.user.keep_photo;
  const hasShot = !!draft.shot;
  const marked = markedBody(draft.text, draft.highlights);
  ctx.mount(frame("save", "저장하기", "", html`
    <div class="save-preview">${raw(draft.text ? marked.html : '<span class="empty-inline">적은 글자가 없어요.</span>')}</div>
    <p class="hint">${draft.highlights.length ? `밑줄 ${draft.highlights.length}개` : "밑줄 없음"}</p>
    <form class="form" id="save" novalidate>
      ${raw(ctx.field({ id: "cap-page", label: "쪽수 (선택)", inputmode: "numeric", value: lastPage.get(shelfId) ?? "" }))}
      <div class="field"><label for="cap-thought">내 생각 한마디 (선택)</label>
        <textarea id="cap-thought" rows="3" maxlength="2000"></textarea></div>
      ${raw(hasShot ? html`<div class="switch-row">
        <label class="switch"><input type="checkbox" role="switch" id="keep" ${raw(keep ? "checked" : "")}><span class="switch-track" aria-hidden="true"></span><span>사진도 남기기</span></label>
        <p class="hint">켜면 찍은 사진도 함께 저장해요. 끄면 사진은 이 기기에서 버리고 글자만 저장해요. 고른 것은 다음에도 기억해요.</p>
      </div>` : "")}
      <p class="form-error" role="alert"></p>
      <button class="btn btn-primary btn-block" type="submit">저장</button>
    </form>`));
  wireFrame(ctx, shelfId, "save");
  const form = ctx.app.querySelector("#save");
  if (draft.thought) form.querySelector("#cap-thought").value = draft.thought;
  form.querySelector("#cap-thought").addEventListener("input", (e) => { draft.thought = e.target.value; });
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const pageRaw = form.querySelector("#cap-page").value.trim();
    const page = pageRaw === "" ? null : Number(pageRaw);
    if (page !== null && (!Number.isInteger(page) || page < 0 || page > 20000)) return ctx.showError(form, "쪽수는 0~20000 사이 숫자로 적어 주세요.", "cap-page");
    const keepPhoto = !!form.querySelector("#keep")?.checked;
    const body = normalizeText(draft.text);
    if (!body && !keepPhoto) return ctx.showError(form, "적은 글자가 없어요. [뒤로]를 눌러 글자를 적거나 [사진도 남기기]를 켜 주세요.");
    busy(form.querySelector("[type=submit]"), async () => {
      try {
        const payload = {
          shelf_id: shelfId, kind: "capture", body, page,
          thought: form.querySelector("#cap-thought").value,
          highlights: draft.highlights.map(({ start, end }) => ({ start, end })),
        };
        if (hasShot) payload.keep_photo = keepPhoto;
        if (hasShot && keepPhoto) payload.photo = await blobToBase64(await toJpeg(draft.shot, PHOTO_MAX, [0.8, 0.7, 0.6, 0.5], 700000));
        const r = await api.notes.add(payload);
        ctx.state.user.keep_photo = r.keep_photo;
        if (page !== null) lastPage.set(shelfId, page);
        toast(keepPhoto ? "메모와 사진을 저장했어요." : "메모를 저장했어요.");
        clearDraft();
        if (fromBook === shelfId) {
          fromBook = null;
          history.go(-(STEPS.indexOf("save") + 1));
        } else ctx.replace(`book/${shelfId}`);
      } catch (err) { ctx.showError(form, err.message); }
    });
  });
}
