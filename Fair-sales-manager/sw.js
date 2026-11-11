const CACHE = "fair-sales-static-v56";

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

    // Keep the Supabase browser SDK available after it has been loaded once.
    // This supports reopening the installed app during a temporary outage.
    const isSupabaseSdk =
        (url.hostname === "cdn.jsdelivr.net" || url.hostname === "unpkg.com") &&
        url.pathname.includes("@supabase/supabase-js");

    if (url.origin !== self.location.origin) {
        if (!isSupabaseSdk) return;

        event.respondWith((async () => {
            const cache = await caches.open(CACHE);
            const cached = await cache.match(request);
            try {
                const response = await fetch(request);
                if (response && (response.ok || response.type === "opaque")) {
                    await cache.put(request, response.clone());
                }
                return response;
            } catch (error) {
                return cached || Response.error();
            }
        })());
        return;
    }

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
