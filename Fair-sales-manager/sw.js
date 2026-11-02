const CACHE = "fair-sales-static-v2";
const SUPABASE_CDN = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2";

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

        try {
            const response = await fetch(SUPABASE_CDN, { mode: "cors" });
            if (response.ok) {
                await cache.put(SUPABASE_CDN, response);
            }
        } catch (error) {
            console.warn("Supabase library could not be cached:", error);
        }

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

    if (url.href === SUPABASE_CDN) {
        event.respondWith((async () => {
            const cache = await caches.open(CACHE);
            const cached = await cache.match(SUPABASE_CDN);
            if (cached) return cached;

            try {
                const response = await fetch(request);
                if (response.ok) await cache.put(SUPABASE_CDN, response.clone());
                return response;
            } catch (error) {
                return new Response("Supabase library unavailable offline.", {
                    status: 503,
                    headers: { "Content-Type": "text/plain" }
                });
            }
        })());
        return;
    }

    if (url.origin !== self.location.origin) return;

    event.respondWith(
        fetch(request)
            .then((response) => {
                if (response.ok) {
                    caches.open(CACHE).then((cache) =>
                        cache.put(request, response.clone())
                    );
                }
                return response;
            })
            .catch(() => caches.match(request).then((cached) => {
                if (cached) return cached;
                if (request.mode === "navigate") {
                    return caches.match("./index.html");
                }
                return Response.error();
            }))
    );
});
