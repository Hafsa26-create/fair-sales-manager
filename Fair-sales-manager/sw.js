const CACHE = "fair-sales-static-v41";

const FILES = [
    "./",
    "./index.html",
    "./styles.css",
    "./config.js",
    "./app.js",
    "./manifest.webmanifest",
    "./icon.svg"
];

self.addEventListener("install", (event) => {
    event.waitUntil((async () => {
        const cache = await caches.open(CACHE);
        await cache.addAll(FILES);

        await self.skipWaiting();
    })());
});

self.addEventListener("activate", (event) => {
    event.waitUntil((async () => {
        const keys = await caches.keys();
        await Promise.all(
            keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))
        );
        await self.clients.claim();
    })());
});

self.addEventListener("fetch", (event) => {
    const request = event.request;
    const url = new URL(request.url);

    if (request.method !== "GET") return;

    if (url.origin !== self.location.origin) return;

    event.respondWith(
        fetch(request).catch(() => caches.match(request).then((cached) => {
            if (cached) return cached;
            if (request.mode === "navigate") {
                return caches.match("./index.html");
            }
            return Response.error();
        }))
    );
});
