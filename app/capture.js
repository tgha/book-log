// book-log 3단계 화면: 문장 찍기 (1.3.0 간소화)
//   [문장 찍기] → 앱 안 카메라로 소리 없이 찍기 → 읽을 부분 감싸기(모서리 · 테두리 선) → [글자 읽기]
//   → 첫 단어 · 끝 단어 누르기 → 쪽수 → [저장]
// · 무음: 폰 기본 카메라 앱(한국 폰은 셔터음을 끌 수 없음) 대신, 앱 안 카메라 화면에서 한 장을 떼어 낸다
// · 사진 펴기(원근 보정)는 외부 도구 없이 이 폰 안에서 계산한다 (보안 규칙상 외부 스크립트 불가)
// · 단계마다 주소가 바뀌어(#/capture/<책>/camera|area|choose) 폰의 뒤로 가기로 앞 단계에 돌아갈 수 있다
// · 만들던 메모(draft)는 이 화면 안에만 있다. 저장하거나 새로 찍으면 비운다
import { api } from "./api.js";
import { busy, html, raw, toast } from "./ui.js";

const STEPS = ["camera", "area", "choose"];
const SRC_MAX = 2400;    // 사진을 열 때 긴 쪽 최대 (폰 메모리 아끼기)
const FLAT_MAX = 2000;   // 편 사진 긴 쪽 최대
const OCR_MAX = 2000;    // 글자 읽기로 보내는 사진 긴 쪽 최대
const PHOTO_MAX = 1600;  // 남기는 사진 긴 쪽 최대 (약 0.3MB)
const HANDLE_NAMES = ["왼쪽 위 모서리", "오른쪽 위 모서리", "오른쪽 아래 모서리", "왼쪽 아래 모서리"];
const EDGE_NAMES = ["위쪽 선", "오른쪽 선", "아래쪽 선", "왼쪽 선"];

let draft = null;
let fromBook = null;        // 책 화면의 [문장 찍기]로 들어왔으면 그 책 번호 (저장 뒤 책 화면으로 되돌아가기)
// 책마다 마지막에 적은 쪽수 (앱을 닫았다 열어도 남게 이 기기에 저장)
const PAGE_KEY = "bk_last_page";
const lastPage = {
  all() { try { return JSON.parse(localStorage.getItem(PAGE_KEY) || "{}") || {}; } catch { return {}; } },
  get(id) { const v = this.all()[id]; return Number.isInteger(v) ? v : undefined; },
  set(id, page) {
    const a = this.all();
    delete a[id];
    a[id] = page;
    const keys = Object.keys(a);
    keys.slice(0, Math.max(0, keys.length - 200)).forEach((k) => delete a[k]); // 오래된 책부터 정리
    try { localStorage.setItem(PAGE_KEY, JSON.stringify(a)); } catch { /* 저장 불가 */ }
  },
  clear() { try { localStorage.removeItem(PAGE_KEY); } catch { /* 무시 */ } },
};
const books = new Map();    // 서재 번호 → 책 정보 (제목 표시용)
let cleanups = [];

export function markFromBook(shelfId) { fromBook = shelfId; }
export function leaveCapture() {
  cleanups.forEach((f) => { try { f(); } catch { /* 무시 */ } });
  cleanups = [];
}
export function resetCapture() { leaveCapture(); clearDraft(); fromBook = null; lastPage.clear(); books.clear(); }
function clearDraft() {
  if (draft?.imageUrl) URL.revokeObjectURL(draft.imageUrl);
  draft = null;
}

// ── 글자 도우미 ────────────────────────────────────────────
/** 서버와 똑같이 정리 (줄바꿈 통일 · 줄 끝과 앞뒤 공백 제거) */
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

// ── 사진 위 편집기: 모서리 동그라미 4개 + 테두리 선 4개 ─────────────────
function stageHtml() {
  return html`<div class="stage-wrap"><div class="stage" id="stage" role="group" aria-label="읽을 부분">
    <canvas class="stage-img" aria-hidden="true"></canvas>
    <svg class="stage-lines" aria-hidden="true"><path class="shade" fill-rule="evenodd"></path><polygon class="edge"></polygon></svg>
    ${EDGE_NAMES.map((n, i) => raw(html`<button type="button" class="edge-handle" data-e="${i}" aria-label="${n} (화살표 키로 옮기기)"></button>`))}
    ${HANDLE_NAMES.map((n, i) => raw(html`<button type="button" class="handle" data-h="${i}" aria-label="${n} (화살표 키로 옮기기)"></button>`))}
    <canvas class="loupe" hidden aria-hidden="true"></canvas>
    <div class="stage-busy" hidden><span></span></div>
  </div></div>`;
}

function mountEditor(stage, src, pts, onChange) {
  const img = stage.querySelector(".stage-img");
  const svg = stage.querySelector(".stage-lines");
  const shade = svg.querySelector(".shade");
  const edge = svg.querySelector(".edge");
  const handles = [...stage.querySelectorAll(".handle")];
  const edges = [...stage.querySelectorAll(".edge-handle")];
  const loupe = stage.querySelector(".loupe");
  const L = 132;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  let scale = 1;
  let dw = 0;
  let dh = 0;

  const paint = () => {
    const d = pts.map(([x, y]) => [x * scale, y * scale]);
    edge.setAttribute("points", d.map((p) => p.join(",")).join(" "));
    shade.setAttribute("d", `M0 0H${dw}V${dh}H0Z M${d.map((p) => p.join(" ")).join(" L")}Z`);
    handles.forEach((h, i) => { h.style.left = `${d[i][0]}px`; h.style.top = `${d[i][1]}px`; });
    edges.forEach((h, i) => {
      const a = d[i];
      const b = d[(i + 1) % 4];
      h.style.left = `${(a[0] + b[0]) / 2}px`;
      h.style.top = `${(a[1] + b[1]) / 2}px`;
      h.style.setProperty("--rot", `${Math.atan2(b[1] - a[1], b[0] - a[0])}rad`);
    });
  };
  const layout = () => {
    const maxW = stage.parentElement.clientWidth || 360;
    const maxH = Math.max(260, Math.round(window.innerHeight * 0.62));
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

  const clampPoint = (x, y) => [Math.min(src.width, Math.max(0, x)), Math.min(src.height, Math.max(0, y))];
  /** 선 옮기기: 두 끝점을 같이 옮기되, 둘 다 사진 밖으로 나가지 않게 */
  const moveEdge = (i, orig, dx, dy) => {
    const j = (i + 1) % 4;
    const xs = [orig[0][0], orig[1][0]];
    const ys = [orig[0][1], orig[1][1]];
    dx = Math.min(src.width - Math.max(...xs), Math.max(-Math.min(...xs), dx));
    dy = Math.min(src.height - Math.max(...ys), Math.max(-Math.min(...ys), dy));
    pts[i][0] = orig[0][0] + dx; pts[i][1] = orig[0][1] + dy;
    pts[j][0] = orig[1][0] + dx; pts[j][1] = orig[1][1] + dy;
  };

  /** 확대경: 사진 좌표 (cx,cy) 둘레를 3배로, segs 는 함께 그릴 선 [[점, 점], ...] */
  const drawLoupe = (cx, cy, segs) => {
    const side = L / scale / 3;
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
    segs.forEach(([a, b]) => { const [ax, ay] = toL(a); const [bx, by] = toL(b); g.moveTo(ax, ay); g.lineTo(bx, by); });
    g.stroke();
    g.strokeStyle = "#fff";
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(L / 2 - 10, L / 2); g.lineTo(L / 2 + 10, L / 2);
    g.moveTo(L / 2, L / 2 - 10); g.lineTo(L / 2, L / 2 + 10);
    g.stroke();
    // 손가락에 가리지 않게: 위쪽, 자리가 없으면 옆쪽
    const px = cx * scale;
    const py = cy * scale;
    let lx = px - L / 2;
    let ly = py - L - 56;
    if (ly < -8) { ly = Math.min(dh - L, Math.max(0, py - L / 2)); lx = px < dw / 2 ? px + 56 : px - L - 56; }
    loupe.style.left = `${Math.min(dw - L, Math.max(0, lx))}px`;
    loupe.style.top = `${ly}px`;
    loupe.hidden = false;
  };
  const loupeFor = (drag) => {
    if (drag.type === "corner") {
      const i = drag.i;
      drawLoupe(pts[i][0], pts[i][1], [[pts[(i + 3) % 4], pts[i]], [pts[i], pts[(i + 1) % 4]]]);
    } else {
      const a = pts[drag.i];
      const b = pts[(drag.i + 1) % 4];
      drawLoupe(a[0] + (b[0] - a[0]) * drag.t, a[1] + (b[1] - a[1]) * drag.t, [[a, b]]);
    }
  };

  let drag = null;
  const local = (e) => { const r = stage.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  stage.addEventListener("pointerdown", (e) => {
    if (stage.classList.contains("is-busy")) return;
    const [px, py] = local(e);
    const d = pts.map(([x, y]) => [x * scale, y * scale]);
    let ci = -1;
    let cd = Infinity;
    d.forEach(([x, y], i) => { const dd = Math.hypot(x - px, y - py); if (dd < cd) { cd = dd; ci = i; } });
    let ei = -1;
    let ed = Infinity;
    let et = 0.5;
    d.forEach((a, i) => {
      const b = d[(i + 1) % 4];
      const vx = b[0] - a[0];
      const vy = b[1] - a[1];
      const len2 = vx * vx + vy * vy || 1;
      const t = Math.min(1, Math.max(0, ((px - a[0]) * vx + (py - a[1]) * vy) / len2));
      const dd = Math.hypot(a[0] + vx * t - px, a[1] + vy * t - py);
      if (dd < ed) { ed = dd; ei = i; et = t; }
    });
    if (cd <= 40 || (cd <= 56 && ed > 30)) drag = { type: "corner", i: ci, offset: [d[ci][0] - px, d[ci][1] - py] };
    else if (ed <= 30) drag = { type: "edge", i: ei, t: et, start: [px / scale, py / scale], orig: [[...pts[ei]], [...pts[(ei + 1) % 4]]] };
    else return;
    e.preventDefault();
    stage.setPointerCapture(e.pointerId);
    (drag.type === "corner" ? handles[drag.i] : edges[drag.i]).classList.add("dragging");
    loupeFor(drag);
  });
  stage.addEventListener("pointermove", (e) => {
    if (!drag) return;
    e.preventDefault();
    const [px, py] = local(e);
    if (drag.type === "corner") {
      const [x, y] = clampPoint((px + drag.offset[0]) / scale, (py + drag.offset[1]) / scale);
      pts[drag.i][0] = x; pts[drag.i][1] = y;
    } else {
      moveEdge(drag.i, drag.orig, px / scale - drag.start[0], py / scale - drag.start[1]);
    }
    paint();
    loupeFor(drag);
  });
  const end = () => {
    if (!drag) return;
    (drag.type === "corner" ? handles[drag.i] : edges[drag.i]).classList.remove("dragging");
    drag = null;
    loupe.hidden = true;
    onChange?.();
  };
  stage.addEventListener("pointerup", end);
  stage.addEventListener("pointercancel", end);
  const arrow = (e) => {
    const step = (e.shiftKey ? 20 : 3) / scale;
    return { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
  };
  handles.forEach((h, i) => h.addEventListener("keydown", (e) => {
    const mv = arrow(e);
    if (!mv) return;
    e.preventDefault();
    [pts[i][0], pts[i][1]] = clampPoint(pts[i][0] + mv[0], pts[i][1] + mv[1]);
    paint();
    onChange?.();
  }));
  edges.forEach((h, i) => h.addEventListener("keydown", (e) => {
    const mv = arrow(e);
    if (!mv) return;
    e.preventDefault();
    moveEdge(i, [[...pts[i]], [...pts[(i + 1) % 4]]], mv[0], mv[1]);
    paint();
    onChange?.();
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

// ── 단어 눌러 고르기 (첫 단어 → 끝 단어) ────────────────────────────
function wordsOf(text) {
  const out = [];
  const re = /\S+/g;
  let m;
  while ((m = re.exec(text))) out.push([m.index, m.index + m[0].length]);
  return out;
}

function mountChooser(container, text, initial, onChange) {
  const ws = wordsOf(text);
  let a = null;
  let b = null;
  if (initial) {
    const i = ws.findIndex(([s, e]) => e > initial.start);
    let j = -1;
    ws.forEach(([s], k) => { if (s < initial.end) j = k; });
    if (i >= 0 && j >= i) { a = i; b = j; }
  }
  let out = "";
  let at = 0;
  ws.forEach(([s, e], i) => {
    const gap = text.slice(at, s);
    out += gap.includes("\n") ? "<br>".repeat(Math.min(2, gap.split("\n").length - 1)) : gap ? " " : "";
    out += html`<button type="button" class="w" data-i="${i}" aria-pressed="false">${text.slice(s, e)}</button>`;
    at = e;
  });
  container.innerHTML = out;
  const buttons = [...container.querySelectorAll("button.w")];
  const paint = () => {
    const lo = a === null ? -1 : Math.min(a, b ?? a);
    const hi = a === null ? -1 : Math.max(a, b ?? a);
    buttons.forEach((btn, i) => {
      const on = i >= lo && i <= hi;
      btn.classList.toggle("sel", on);
      btn.classList.toggle("anchor", i === a && b === null);
      btn.setAttribute("aria-pressed", String(on));
    });
  };
  const report = () => {
    if (a === null) return onChange(null);
    if (b === null) return onChange({ first: text.slice(ws[a][0], ws[a][1]) });
    return onChange({ start: ws[Math.min(a, b)][0], end: ws[Math.max(a, b)][1] });
  };
  container.addEventListener("click", (e) => {
    const btn = e.target.closest("button.w");
    if (!btn) return;
    const i = Number(btn.dataset.i);
    if (a === null || b !== null) { a = i; b = null; } else b = i;
    paint();
    report();
  });
  paint();
  return { reset() { a = null; b = null; paint(); report(); }, report };
}

// ── 화면 틀 ─────────────────────────────────────────────
function frame(shelfId, title, help, body) {
  return html`
    <main class="shell no-tabs capture">
      <header class="topbar"><button class="back" type="button" data-cap-back>← 뒤로</button>
        <span class="cap-book" id="cap-book">${books.get(shelfId)?.title || ""}</span></header>
      <h1 class="who">${title}</h1>
      ${raw(help ? html`<p class="cap-help">${help}</p>` : "")}
      ${raw(body)}
    </main>`;
}

function wireFrame(ctx, shelfId, step) {
  ctx.app.querySelector("[data-cap-back]").addEventListener("click", () => {
    if (step !== "camera") return history.back();
    if (fromBook === shelfId) { fromBook = null; history.back(); } else ctx.go(`book/${shelfId}`);
  });
}

const goStep = (ctx, shelfId, step) => ctx.go(`capture/${shelfId}/${step}`);

// ── 길 찾기 ─────────────────────────────────────────────
export function viewCapture(ctx, shelfId, step) {
  if (!shelfId) return ctx.go("shelf");
  if (!STEPS.includes(step)) return ctx.replace(`capture/${shelfId}/camera`);
  if (draft && draft.shelfId !== shelfId) clearDraft();
  if (step === "area" && !draft?.src) return ctx.replace(`capture/${shelfId}/camera`);
  if (step === "choose" && typeof draft?.text !== "string") return ctx.replace(`capture/${shelfId}/${draft?.src ? "area" : "camera"}`);
  if (step === "camera") return stepCamera(ctx, shelfId);
  if (step === "area") return stepArea(ctx, shelfId);
  return stepChoose(ctx, shelfId);
}

// ── 1. 찍기 (앱 안 카메라, 소리 없음) ─────────────────────────────
async function stepCamera(ctx, shelfId) {
  const route = `capture/${shelfId}/camera`;
  const coarse = matchMedia("(pointer: coarse)").matches;
  ctx.mount(frame(shelfId, "문장 찍기", "", html`
    <div class="camera" id="camera" hidden>
      <video id="cam" playsinline muted></video>
      <button class="torch" type="button" id="torch" hidden aria-pressed="false">손전등</button>
    </div>
    <p class="cap-help" id="cam-status" role="status"></p>
    <div class="shutter-row" id="shutter-row" hidden>
      <button class="shutter" type="button" id="shoot"><span class="visually-hidden">찍기</span></button>
    </div>
    <p class="hint center" id="cam-hint" hidden>소리 없이 찍혀요. 읽을 쪽이 화면에 크고 또렷하게 나오게 비춰 주세요.</p>
    <div class="pick-ways">
      ${raw(coarse ? "" : html`<label class="btn btn-primary btn-block file-btn">사진 파일 올리기<input class="file-input" type="file" accept="image/*" data-file></label>
        <button class="btn btn-quiet btn-block" type="button" id="webcam">웹캠으로 찍기</button>`)}
      ${raw(coarse ? html`<label class="btn btn-quiet btn-block file-btn">사진첩에서 고르기<input class="file-input" type="file" accept="image/*" data-file></label>` : "")}
    </div>
    <p class="scan-help" id="pick-status" role="status"></p>`));
  wireFrame(ctx, shelfId, "camera");
  const $ = (s) => ctx.app.querySelector(s);
  const status = $("#cam-status");

  if (!books.has(shelfId)) {
    api.shelf.get(shelfId).then(({ item }) => {
      books.set(shelfId, item.book);
      const el = ctx.isCurrent(route) && $("#cap-book");
      if (el) el.textContent = item.book.title;
    }).catch((err) => { if (ctx.isCurrent(route)) status.textContent = err.message; });
  }

  const begin = (src) => {
    clearDraft();
    const ix = src.width * 0.06;
    const iy = src.height * 0.06;
    draft = {
      shelfId, src,
      quad: [[ix, iy], [src.width - ix, iy], [src.width - ix, src.height - iy], [ix, src.height - iy]],
      flat: null, flatKey: null, readKey: null, imageUrl: null,
      text: null, sel: null, edited: null, thought: "",
    };
    goStep(ctx, shelfId, "area");
  };

  ctx.app.querySelectorAll("[data-file]").forEach((input) => input.addEventListener("change", async () => {
    const file = input.files[0];
    if (!file) return;
    $("#pick-status").textContent = "사진을 여는 중…";
    try {
      const src = await loadImage(file);
      leaveCapture();
      if (ctx.isCurrent(route)) begin(src);
    } catch (err) { $("#pick-status").textContent = err.message; }
  }));

  const startCamera = async () => {
    const fail = (msg) => { status.textContent = msg; };
    if (!navigator.mediaDevices?.getUserMedia) return fail("이 브라우저에서는 카메라를 쓸 수 없어요. 사진첩에서 골라 주세요.");
    status.textContent = "카메라를 켜는 중…";
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" }, width: { ideal: 3840 }, height: { ideal: 2160 } },
        audio: false,
      });
    } catch (e) {
      return fail(e && e.name === "NotAllowedError"
        ? "카메라 사용이 막혀 있어요. 크롬 주소창 왼쪽 아이콘 → 권한에서 카메라를 허용한 뒤 다시 들어오거나, 사진첩에서 골라 주세요."
        : "카메라를 켤 수 없어요. 사진첩에서 골라 주세요.");
    }
    if (!ctx.isCurrent(route)) { stream.getTracks().forEach((tr) => tr.stop()); return; }
    const stop = () => stream.getTracks().forEach((tr) => tr.stop());
    cleanups.push(stop);
    const track = stream.getVideoTracks()[0];
    const caps = track && track.getCapabilities ? track.getCapabilities() : {};
    if (caps.focusMode && caps.focusMode.includes("continuous")) {
      try { await track.applyConstraints({ advanced: [{ focusMode: "continuous" }] }); } catch { /* 지원 안 하면 그대로 */ }
    }
    if (caps.torch) {
      const torch = $("#torch");
      torch.hidden = false;
      torch.addEventListener("click", async () => {
        const on = torch.getAttribute("aria-pressed") !== "true";
        try { await track.applyConstraints({ advanced: [{ torch: on }] }); torch.setAttribute("aria-pressed", String(on)); } catch { /* 무시 */ }
      });
    }
    const video = $("#cam");
    video.srcObject = stream;
    $("#camera").hidden = false;
    try { await video.play(); } catch { /* 자동 재생 막힘은 무시 */ }
    if (!video.videoWidth) await new Promise((ok) => video.addEventListener("loadedmetadata", ok, { once: true }));
    if (!ctx.isCurrent(route)) return;
    status.textContent = "";
    $("#shutter-row").hidden = false;
    $("#cam-hint").hidden = false;
    const shoot = $("#shoot");
    shoot.setAttribute("aria-label", "찍기 (소리 없음)");
    shoot.focus();
    shoot.addEventListener("click", () => {
      const vw = video.videoWidth;
      const vh = video.videoHeight;
      if (!vw || !vh) return;
      const k = Math.min(1, SRC_MAX / Math.max(vw, vh));
      const c = makeCanvas(vw * k, vh * k);
      const g = c.getContext("2d");
      g.imageSmoothingQuality = "high";
      g.drawImage(video, 0, 0, c.width, c.height);
      leaveCapture(); // 카메라 끄기
      begin(c);
    });
  };

  if (coarse) startCamera();
  else $("#webcam").addEventListener("click", (e) => { e.currentTarget.hidden = true; startCamera(); });
}

// ── 2. 읽을 부분 감싸기 → 글자 읽기 ─────────────────────────────
const quadKey = (q) => q.map((p) => p.map((v) => Math.round(v)).join(",")).join(";");

function stepArea(ctx, shelfId) {
  const route = `capture/${shelfId}/area`;
  const alreadyRead = () => draft.readKey !== null && draft.readKey === quadKey(orderQuad(draft.quad));
  ctx.mount(frame(shelfId, "읽을 부분 감싸기", "모서리 동그라미나 테두리 선을 끌어 읽을 부분을 감싸 주세요. 한 단락만 감싸도 돼요.", html`
    ${raw(stageHtml())}
    <div class="cap-error" id="ocr-error" hidden>
      <p role="alert" id="ocr-error-text"></p>
      <div class="row-actions" id="ocr-error-actions">
        <button class="btn btn-primary btn-small" type="button" id="retry">다시 시도</button>
        <button class="btn btn-quiet btn-small" type="button" data-manual>직접 입력</button>
      </div>
    </div>
    <button class="btn btn-primary btn-block" type="button" id="read">글자 읽기</button>
    <p class="quota" id="quota" role="status"></p>
    <div class="row-actions center">
      <button class="btn btn-quiet btn-small" type="button" id="retake">다시 찍기</button>
      <button class="btn btn-quiet btn-small" type="button" data-manual>글자 읽지 않고 직접 입력</button>
    </div>`));
  wireFrame(ctx, shelfId, "area");
  const $ = (s) => ctx.app.querySelector(s);
  const readBtn = $("#read");
  const quota = $("#quota");
  const errBox = $("#ocr-error");
  let limitReached = false;
  const label = () => {
    readBtn.textContent = alreadyRead() ? "다음" : "글자 읽기";
    readBtn.disabled = limitReached && !alreadyRead();
  };
  const showQuota = (used, limit) => {
    limitReached = used >= limit;
    quota.textContent = `오늘 글자 읽기 ${used} / ${limit}번${limitReached ? " — 오늘은 다 썼어요. [직접 입력]으로 적을 수 있어요." : ""}`;
    label();
  };
  const editor = mountEditor($("#stage"), draft.src, draft.quad, label);
  label();
  const refreshQuota = () => api.ocr.quota().then((r) => {
    if (typeof r.keep_photo === "boolean") ctx.state.user.keep_photo = r.keep_photo; // 다른 기기에서 바꾼 기억값
    if (ctx.isCurrent(route)) showQuota(r.used, r.limit);
  }).catch(() => { /* 읽기를 누르면 서버가 다시 알려 줌 */ });
  refreshQuota();

  const showError = (msg, withActions) => {
    $("#ocr-error-text").textContent = msg;
    $("#ocr-error-actions").hidden = !withActions;
    errBox.hidden = false;
    errBox.scrollIntoView({ block: "nearest", behavior: "smooth" });
  };

  /** 감싼 부분을 펴서 draft.flat 에 (같은 자리면 다시 계산 안 함) */
  const flatten = (q) => {
    const key = quadKey(q);
    if (draft.flatKey !== key) {
      draft.flat = warp(draft.src, q);
      draft.flatKey = key;
      if (draft.imageUrl) { URL.revokeObjectURL(draft.imageUrl); draft.imageUrl = null; }
    }
  };

  const read = (button) => busy(button, async () => {
    const q = orderQuad(draft.quad);
    if (!isConvex(q)) return showError("동그라미 네 개가 읽을 부분을 둘러싸도록 놓아 주세요.", false);
    if (alreadyRead()) return goStep(ctx, shelfId, "choose");
    errBox.hidden = true;
    editor.busy(true, "글자를 읽는 중…");
    await nextFrame();
    let blob;
    try {
      flatten(q);
      blob = await toJpeg(draft.flat, OCR_MAX, [0.85, 0.72, 0.6], 1400000);
      if (!draft.imageUrl) draft.imageUrl = URL.createObjectURL(blob);
    } catch {
      editor.busy(false);
      return showError("읽을 부분을 펴지 못했어요. 동그라미 위치를 바꿔 다시 눌러 주세요.", false);
    }
    try {
      const { text, used, limit } = await api.ocr.read(await blobToBase64(blob));
      if (!ctx.isCurrent(route)) return;
      draft.text = joinLines(normalizeText(text));
      draft.sel = null;
      draft.edited = null;
      draft.readKey = draft.flatKey;
      showQuota(used, limit);
      goStep(ctx, shelfId, "choose");
    } catch (err) {
      if (!ctx.isCurrent(route)) return;
      editor.busy(false);
      showError(err.message, true);
      $("#retry").hidden = err.code === "OCR_LIMIT" || err.code === "NO_VISION_KEY";
      refreshQuota();
    }
  });
  readBtn.addEventListener("click", () => read(readBtn));
  $("#retry").addEventListener("click", (e) => read(e.currentTarget));
  $("#retake").addEventListener("click", () => history.back());
  ctx.app.querySelectorAll("[data-manual]").forEach((b) => b.addEventListener("click", () => busy(b, async () => {
    const q = orderQuad(draft.quad);
    try { if (isConvex(q)) flatten(q); else { draft.flat = draft.src; draft.flatKey = null; } } catch { draft.flat = draft.src; draft.flatKey = null; }
    if (!draft.imageUrl) draft.imageUrl = URL.createObjectURL(await toJpeg(draft.flat, PHOTO_MAX, [0.8], 2000000));
    draft.text = "";
    draft.sel = null;
    draft.readKey = null;
    goStep(ctx, shelfId, "choose");
  })));
}

// ── 3. 문장 고르기 · 쪽수 · 저장 ──────────────────────────────────
function stepChoose(ctx, shelfId) {
  const hasText = !!draft.text;
  const keep = !!ctx.state.user.keep_photo;
  const last = lastPage.get(shelfId);
  ctx.mount(frame(shelfId, hasText ? "문장 고르기" : "문장 적기", "", html`
    ${raw(hasText ? html`
      <p class="pick-help" id="pick-help" role="status"></p>
      <div class="reader reading" id="chooser"></div>
      <div class="chosen" id="chosen" hidden>
        <div class="chosen-head"><span class="note-meta" id="chosen-count"></span>
          <span class="chosen-links"><button class="link-btn" type="button" id="edit-chosen">글자 고치기</button>
          <button class="link-btn" type="button" id="clear-sel">다시 고르기</button></span></div>
        <p class="chosen-text reading" id="chosen-text"></p>
      </div>` : "")}
    <div class="field" id="edit-field" ${raw(hasText ? "hidden" : "")}>
      <label for="cap-body">${hasText ? "고른 문장 고치기" : "책의 문장"}</label>
      <textarea id="cap-body" class="reading" rows="6"></textarea>
    </div>
    <form class="form" id="save" novalidate>
      ${raw(ctx.field({ id: "cap-page", label: "쪽수", inputmode: "numeric", hint: last !== undefined ? `지난번에 ${last}쪽을 적었어요` : "" }))}
      <details class="more" id="more">
        <summary>더 하기<span id="more-state"></span></summary>
        <div class="more-body">
          <div class="field"><label for="cap-thought">내 생각 한마디 (선택)</label>
            <textarea id="cap-thought" rows="3" maxlength="2000"></textarea></div>
          ${raw(draft.flat ? html`<div class="switch-row">
            <label class="switch"><input type="checkbox" role="switch" id="keep" ${raw(keep ? "checked" : "")}><span class="switch-track" aria-hidden="true"></span><span>사진도 남기기</span></label>
            <p class="hint">켜면 찍은 부분 사진도 함께 저장해요. 고른 것은 다음에도 기억해요.</p>
          </div>` : "")}
          ${raw(draft.imageUrl ? html`<figure class="kept-photo"><img id="shot-img" src="${draft.imageUrl}" alt="찍은 부분"></figure>` : "")}
        </div>
      </details>
      <p class="form-error" role="alert"></p>
      <button class="btn btn-primary btn-block" type="submit">저장</button>
    </form>`));
  wireFrame(ctx, shelfId, "choose");
  const $ = (s) => ctx.app.querySelector(s);
  const form = $("#save");
  const ta = $("#cap-body");
  const editField = $("#edit-field");
  const keepBox = $("#keep");
  const current = () => (draft.edited !== null ? draft.edited : draft.sel ? draft.text.slice(draft.sel.start, draft.sel.end) : draft.text);

  const moreState = () => {
    const bits = [];
    if (keepBox?.checked) bits.push("사진 남김");
    if (draft.thought.trim()) bits.push("내 생각");
    $("#more-state").textContent = bits.length ? ` · ${bits.join(" · ")}` : "";
  };
  $("#cap-thought").value = draft.thought;
  $("#cap-thought").addEventListener("input", (e) => { draft.thought = e.target.value; moreState(); });
  keepBox?.addEventListener("change", moreState);
  moreState();

  if (hasText) {
    const help = $("#pick-help");
    const chosen = $("#chosen");
    const show = () => {
      const t = current();
      $("#chosen-text").textContent = t;
      $("#chosen-count").textContent = `고른 문장 · ${t.replace(/\s+/g, " ").trim().length}자`;
    };
    const chooser = mountChooser($("#chooser"), draft.text, draft.sel, (r) => {
      if (r && r.first) {
        help.textContent = `「${r.first}」부터 — 끝 단어를 누르세요.`;
        return;
      }
      if (r) {
        const changed = !draft.sel || draft.sel.start !== r.start || draft.sel.end !== r.end;
        draft.sel = r;
        if (changed && draft.edited !== null) { draft.edited = null; editField.hidden = true; toast("새로 고른 문장으로 바꿨어요."); }
        help.textContent = "고른 문장을 저장해요. 다른 곳을 누르면 새로 골라요.";
        chosen.hidden = false;
        $("#chosen-text").hidden = draft.edited !== null;
        show();
        return;
      }
      draft.sel = null;
      help.textContent = "저장할 문장의 첫 단어를 누르세요. 고르지 않으면 읽은 글 전체를 저장해요.";
      chosen.hidden = true;
    });
    chooser.report();
    if (draft.edited !== null) { editField.hidden = false; ta.value = draft.edited; chosen.hidden = false; $("#chosen-text").hidden = true; show(); }
    $("#edit-chosen").addEventListener("click", () => {
      if (draft.edited === null) draft.edited = current();
      ta.value = draft.edited;
      editField.hidden = false;
      $("#chosen-text").hidden = true;
      ta.focus();
    });
    $("#clear-sel").addEventListener("click", () => {
      draft.edited = null;
      editField.hidden = true;
      chooser.reset();
    });
    ta.addEventListener("input", () => { draft.edited = ta.value; show(); });
  } else {
    ta.value = draft.edited ?? "";
    ta.placeholder = "책의 문장을 적어 주세요.";
    ta.addEventListener("input", () => { draft.edited = ta.value; });
  }

  form.querySelector("#cap-page").addEventListener("input", () => {
    if (form.querySelector(".form-error").textContent) ctx.showError(form, "");
  });
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const pageRaw = form.querySelector("#cap-page").value.trim();
    const page = pageRaw === "" ? null : Number(pageRaw);
    if (page !== null && (!Number.isInteger(page) || page < 0 || page > 20000)) return ctx.showError(form, "쪽수는 0~20000 사이 숫자로 적어 주세요.", "cap-page");
    const keepPhoto = !!keepBox?.checked;
    const body = normalizeText(current());
    if (!body && !keepPhoto) return ctx.showError(form, hasText ? "저장할 글자가 없어요. 문장을 다시 골라 주세요." : "책의 문장을 적어 주세요.");
    busy(form.querySelector("[type=submit]"), async () => {
      try {
        const payload = { shelf_id: shelfId, kind: "capture", body, page, thought: draft.thought };
        if (draft.flat) payload.keep_photo = keepPhoto;
        if (draft.flat && keepPhoto) payload.photo = await blobToBase64(await toJpeg(draft.flat, PHOTO_MAX, [0.8, 0.7, 0.6, 0.5], 700000));
        const r = await api.notes.add(payload);
        ctx.state.user.keep_photo = r.keep_photo;
        if (page !== null) lastPage.set(shelfId, page);
        toast(keepPhoto ? "문장과 사진을 저장했어요." : "문장을 저장했어요.");
        clearDraft();
        if (fromBook === shelfId) {
          fromBook = null;
          history.go(-STEPS.length); // 책 → 찍기 → 감싸기 → 고르기
        } else ctx.replace(`book/${shelfId}`);
      } catch (err) { ctx.showError(form, err.message); }
    });
  });
}
