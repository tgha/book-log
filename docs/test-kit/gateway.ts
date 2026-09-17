// 로컬 시험용: Supabase 주소 모양 흉내 + 가짜 카카오 책 검색 + 가짜 구글 Vision + 가짜 사진 창고(bk-photos)
const fns: Record<string, number> = { "bk-auth": 9001, "bk-admin": 9002, "bk-book": 9003, "bk-api": 9004, "bk-ocr": 9005 };
// 가짜 Vision 동작 바꾸기: GET /__vision?mode=ok|empty|err500|badkey|denied|quota|badimage|slow|text&text=...
let visionMode = "ok"; let visionText = "";
export const VISION_SAMPLE = "우리가 어떤 사건을 현재의 눈으로\n보면, 그 시대 사람들이 무엇을\n생각했는지 놓치기 쉽다.\nHistory is a con-\nversation with the past.";
let visionCalls = 0; let lastVision: unknown = null;
// 글자 위치까지 주는 가짜 응답: [단어, 뒤 간격(px)] — 간격 2 는 거의 붙은 곳(띄어쓰기 의심), 14 는 보통 띄어쓰기
export const LAYOUT_LINES: [string, number][][] = [
  [["우리가", 14], ["어떤", 14], ["사", 2], ["건을", 14], ["현재의", 14], ["눈으로", 0]],
  [["보면,", 14], ["그", 14], ["시", 2], ["대", 14], ["사람들이", 0]],
  [["History", 14], ["is", 14], ["a", 3], ["test.", 0]],
];
const LAYOUT_DOUBT = new Set(["사람들이"]);
function layoutAnnotation() {
  const W = 40, H = 44; let y = 100; let text = "";
  const paragraphs = LAYOUT_LINES.map((line) => {
    let x = 50;
    const words = line.map(([w, gap], wi) => {
      const symbols: Record<string, unknown>[] = [...w].map((ch) => {
        const x0 = x; x += W;
        return { text: ch, boundingBox: { vertices: [{ x: x0, y }, { x: x0 + W, y }, { x: x0 + W, y: y + H }, { x: x0, y: y + H }] } };
      });
      symbols[symbols.length - 1].property = { detectedBreak: { type: wi === line.length - 1 ? "LINE_BREAK" : "SPACE" } };
      x += gap;
      return { symbols, confidence: LAYOUT_DOUBT.has(w) ? 0.4 : 0.98 };
    });
    y += 80; text += line.map((l) => l[0]).join(" ") + "\n";
    return { words };
  });
  return { text, pages: [{ blocks: [{ paragraphs }] }] };
}
// 가짜 사진 창고: 경로 → { bytes, type }
const photos = new Map<string, { bytes: Uint8Array; type: string }>();
const SERVICE = Deno.env.get("SERVICE") ?? "";
const SAPIENS = { title: "사피엔스", authors: ["유발 하라리"], translators: ["조현욱"], publisher: "김영사", datetime: "2015-11-23T00:00:00.000+09:00", isbn: "8934972467 9788934972464", thumbnail: "http://search1.kakaocdn.net/thumb/R120x174/?fname=sapiens", contents: "<b>인류</b>의 역사를 다룬 책" };
const MONEY = { title: "돈의 심리학", authors: ["모건 하우절"], translators: ["이지연"], publisher: "인플루엔셜", datetime: "2023-12-01T00:00:00.000+09:00", isbn: "1168503344 9791168503342", thumbnail: "", contents: "" };
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS" };
Deno.serve({ port: 8000 }, async (req) => {
  const u = new URL(req.url);
  if (u.pathname === "/__vision") {
    visionMode = u.searchParams.get("mode") ?? "ok"; visionText = u.searchParams.get("text") ?? "";
    return Response.json({ mode: visionMode, calls: visionCalls, last: lastVision });
  }
  if (u.pathname === "/__photos") { if (u.searchParams.get("clear")) photos.clear(); return Response.json({ paths: [...photos.keys()] }); }
  if (u.pathname === "/v1/images:annotate") {
    visionCalls++;
    const body = await req.json().catch(() => ({}));
    const r0 = body?.requests?.[0] ?? {};
    lastVision = { key: req.headers.get("x-goog-api-key"), keyInUrl: u.searchParams.has("key"), features: r0.features, hints: r0.imageContext?.languageHints, bytes: (r0.image?.content ?? "").length };
    if (req.headers.get("x-goog-api-key") !== "test-vision-key" || visionMode === "badkey") return Response.json({ error: { code: 400, status: "INVALID_ARGUMENT", message: "API key not valid. Please pass a valid API key." } }, { status: 400 });
    if (visionMode === "denied") return Response.json({ error: { code: 403, status: "PERMISSION_DENIED", message: "Cloud Vision API has not been used in project 1 before or it is disabled." } }, { status: 403 });
    if (visionMode === "quota") return Response.json({ error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "Quota exceeded" } }, { status: 429 });
    if (visionMode === "err500") return new Response("oops", { status: 500 });
    if (visionMode === "badimage") return Response.json({ responses: [{ error: { code: 3, message: "Bad image data." } }] });
    if (visionMode === "empty") return Response.json({ responses: [{}] });
    if (visionMode === "slow") await new Promise((r) => setTimeout(r, 1500));
    if (visionMode === "layout") return Response.json({ responses: [{ fullTextAnnotation: layoutAnnotation() }] });
    const text = visionMode === "text" ? visionText : VISION_SAMPLE;
    return Response.json({ responses: [{ fullTextAnnotation: { text: text + "\n", pages: [] } }] });
  }
  if (req.method === "OPTIONS" && u.pathname.startsWith("/storage/")) return new Response("ok", { headers: cors });
  if (u.pathname.startsWith("/storage/v1/object/")) {
    const rest = u.pathname.slice("/storage/v1/object/".length);
    // 서명 주소로 보기 (열쇠 없이, token 만)
    if (req.method === "GET" && rest.startsWith("sign/")) {
      const path = decodeURIComponent(rest.slice(5).replace(/^bk-photos\//, ""));
      const tok = u.searchParams.get("token") ?? "";
      const f = photos.get(path);
      if (!f || tok !== "tok-" + btoa(path).replace(/=/g, "")) return new Response('{"error":"InvalidJWT"}', { status: 400, headers: cors });
      return new Response(f.bytes, { headers: { "content-type": f.type, ...cors } });
    }
    if (req.headers.get("authorization") !== `Bearer ${SERVICE}`) return new Response('{"statusCode":"403","error":"Unauthorized"}', { status: 403 });
    if (req.method === "POST" && rest === "sign/bk-photos") { // 여러 장 한꺼번에 (createSignedUrls)
      const b = await req.json();
      return Response.json((b.paths ?? []).map((path: string) => photos.has(path)
        ? { path, signedURL: `/object/sign/bk-photos/${path}?token=tok-${btoa(path).replace(/=/g, "")}`, error: null }
        : { path, signedURL: null, error: "Either the object does not exist or you do not have access to it" }));
    }
    if (req.method === "POST" && rest.startsWith("sign/")) {
      const path = decodeURIComponent(rest.slice(5).replace(/^bk-photos\//, ""));
      if (!photos.has(path)) return Response.json({ statusCode: "404", error: "not_found", message: "Object not found" }, { status: 400 });
      return Response.json({ signedURL: `/object/sign/bk-photos/${path}?token=tok-${btoa(path).replace(/=/g, "")}` });
    }
    if (req.method === "DELETE" && rest === "bk-photos") {
      const b = await req.json();
      const gone = (b.prefixes ?? []).filter((p: string) => photos.delete(p));
      return Response.json(gone.map((name: string) => ({ name })));
    }
    if ((req.method === "POST" || req.method === "PUT") && rest.startsWith("bk-photos/")) {
      const path = decodeURIComponent(rest.slice("bk-photos/".length));
      const type = req.headers.get("content-type") ?? "";
      if (!["image/jpeg", "image/png", "image/webp"].includes(type)) return Response.json({ statusCode: "415", error: "invalid_mime_type", message: "mime type not supported" }, { status: 400 });
      if (photos.has(path) && req.headers.get("x-upsert") !== "true") return Response.json({ statusCode: "409", error: "Duplicate", message: "The resource already exists" }, { status: 400 });
      const bytes = new Uint8Array(await req.arrayBuffer());
      if (bytes.length > 2097152) return Response.json({ statusCode: "413", error: "Payload too large", message: "too large" }, { status: 400 });
      photos.set(path, { bytes, type });
      return Response.json({ Key: "bk-photos/" + path, Id: crypto.randomUUID() });
    }
    return new Response("no storage route", { status: 404 });
  }
  if (u.pathname === "/v3/search/book") {
    if (req.headers.get("authorization") !== "KakaoAK test-key") return new Response('{"errorType":"AccessDeniedError"}', { status: 401 });
    const q = u.searchParams.get("query") ?? "", t = u.searchParams.get("target");
    if (q === "ERR500") return new Response("oops", { status: 500 });
    let docs: unknown[] = [];
    if (t === "isbn") docs = [SAPIENS, MONEY].filter((d) => d.isbn.includes(q));
    else if (q.includes("사피엔스")) docs = [SAPIENS];
    else if (q.includes("심리")) docs = [MONEY, SAPIENS];
    return Response.json({ documents: docs, meta: { is_end: true, total_count: docs.length } });
  }
  let target = "";
  if (u.pathname.startsWith("/rest/v1/")) target = "http://127.0.0.1:3000" + u.pathname.slice(8) + u.search;
  else {
    const m = u.pathname.match(/^\/functions\/v1\/(bk-[a-z]+)(\/.*)?$/);
    if (m && fns[m[1]]) target = `http://127.0.0.1:${fns[m[1]]}/${m[1]}${m[2] ?? ""}${u.search}`;
  }
  if (!target) return new Response("no route", { status: 404 });
  // 시험용 가짜 게이트웨이만: 로컬 연결이 끊긴 경우 한 번 더 보냄 (본문을 먼저 읽어 두어야 다시 보낼 수 있음)
  const buf = req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer();
  let r: Response;
  try { r = await fetch(target, { method: req.method, headers: req.headers, body: buf }); }
  catch { r = await fetch(target, { method: req.method, headers: req.headers, body: buf }); }
  return new Response(r.body, { status: r.status, headers: r.headers });
});
