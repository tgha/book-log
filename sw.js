// book-log 서비스 워커: 앱 화면 파일을 기기에 담아 두어 빨리 열리게 함.
// 서버(Supabase) 요청은 담아 두지 않는다. 새 버전을 올리면 CACHE 이름을 바꾼다.
const CACHE = "bk-shell-1.4.0";
const SHELL = [
  "/", "/index.html", "/app/app.css", "/app/main.js", "/app/api.js", "/app/ui.js", "/app/config.js", "/app/books.js", "/app/capture.js", "/app/notes.js",
  "/manifest.webmanifest", "/icons/icon-192.png", "/icons/favicon-48.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith("bk-shell-") && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// 늘 새 파일을 먼저 받아 보고, 인터넷이 안 되면 담아 둔 파일을 쓴다.
self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== self.location.origin) return;
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(async () => (await caches.match(req)) || (req.mode === "navigate" ? caches.match("/index.html") : Response.error())),
  );
});
