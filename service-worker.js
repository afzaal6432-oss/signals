// Bump this version string every time you ship a change to index.html,
// app.js, or the manifest — that's what triggers the "new version
// available" flow below and gets people onto your update automatically.
const CACHE_VERSION = "v10";
const CACHE_NAME = `signalgen-${CACHE_VERSION}`;

const ASSETS_TO_CACHE = [
  "./manifest.json",
  "./icon-192.png",
  "./icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS_TO_CACHE))
  );
  // NOTE: no self.skipWaiting() here — we wait for the person to tap the
  // "update available" banner in index.html, which sends SKIP_WAITING.
  // This lets someone mid-way through generating a signal not get yanked
  // onto a new version unexpectedly.
});

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME) // delete old cached versions
          .map((key) => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  // Network-first for the backend API — never serve stale signal data.
  if (event.request.url.includes("/generate-signal") || event.request.url.includes("/assets") || event.request.url.includes("/health") || event.request.url.includes("/payment/") || event.request.url.includes("/notice") || event.request.url.includes("/support/")) {
    event.respondWith(fetch(event.request));
    return;
  }
  // Network-first for the HTML pages themselves. index.html/admin.html
  // Network-first for the HTML pages themselves. With the backend now on
  // Render (a fixed URL, no more rotating Cloudflare tunnel), this mainly
  // just guards against a stale cached copy of index.html/admin.html
  // lingering after you ship an update. Falls back to the
  // cached copy only when there's genuinely no network (offline support).
  if (event.request.mode === "navigate" || event.request.url.endsWith(".html")) {
    event.respondWith(
      fetch(event.request).catch(() => caches.match(event.request))
    );
    return;
  }
  // Cache-first for the static app-shell assets (icons, manifest) — fast
  // load, safe to cache since they essentially never change.
  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request))
  );
});
