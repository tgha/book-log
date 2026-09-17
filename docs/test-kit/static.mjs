// 로컬 시험용 웹 서버: vercel.json 의 보안 헤더를 그대로 붙이고, 서버 주소만 로컬로 바꿈
import http from "node:http"; import fs from "node:fs"; import path from "node:path";
const ROOT = process.env.ROOT || "/home/claude/book-log";
const vj = JSON.parse(fs.readFileSync(path.join(ROOT, "vercel.json"), "utf8"));
const LOCAL_API = "http://127.0.0.1:8000";
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css", ".png": "image/png", ".webmanifest": "application/manifest+json", ".json": "application/json", ".svg": "image/svg+xml" };
http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (p === "/") p = "/index.html";
  const file = path.join(ROOT, p);
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end("404"); }
  for (const rule of vj.headers) {
    const re = new RegExp("^" + rule.source.replace("(.*)", ".*") + "$");
    if (re.test(p)) for (const h of rule.headers) res.setHeader(h.key, h.value.replace("https://jnsfnwmtrozgiqntrymg.supabase.co", LOCAL_API).replace("img-src 'self' data: blob: https:", "img-src 'self' data: blob: https: " + LOCAL_API));
  }
  let body = fs.readFileSync(file);
  if (p === "/app/config.js") body = Buffer.from(body.toString().replace("https://jnsfnwmtrozgiqntrymg.supabase.co", LOCAL_API));
  res.setHeader("Content-Type", types[path.extname(p)] || "application/octet-stream");
  res.end(body);
}).listen(8080, () => console.log("static 8080"));
