const CACHE = "arc-todo-v2";
const ASSETS = ["/arc-todo/", "/arc-todo/index.html", "/arc-todo/styles.css", "/arc-todo/app.js", "/arc-todo/manifest.webmanifest", "/arc-todo/icon.svg"];
self.addEventListener("install", (event) => event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(ASSETS))));
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET" || new URL(event.request.url).origin !== self.location.origin) return;
  event.respondWith(caches.match(event.request).then((cached) => cached || fetch(event.request)));
});
