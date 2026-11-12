const CACHE = "fair-sales-static-v65";

const FILES = [
    "./",
    "./index.html",
    "./styles.css",
    "./config.js",
    "./app.js",
    "./manifest.webmanifest",
    "./icon.svg"
];

const NETWORK_TIMEOUT_MS = 4500;

async function fetchWithTimeout(request, timeoutMs = NETWORK_TIMEOUT_MS) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(request, { signal: controller.signal });
    } finally {
        clearTimeout(timeout);
    }
}

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
        await Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key)));
        await self.clients.claim();
    })());
});

self.addEventListener("fetch", (event) => {
    const request = event.request;
    if (request.method !== "GET") return;

    const url = new URL(request.url);
    const isSupabaseSdk =
        (url.hostname === "cdn.jsdelivr.net" || url.hostname === "unpkg.com") &&
        url.pathname.includes("@supabase/supabase-js");

    if (url.origin !== self.location.origin) {
        if (!isSupabaseSdk) return;
        event.respondWith((async () => {
            const cache = await caches.open(CACHE);
            const cached = await cache.match(request);
            if (cached) return cached;
            try {
                const response = await fetchWithTimeout(request, 6500);
                if (response && (response.ok || response.type === "opaque")) {
                    await cache.put(request, response.clone());
                }
                return response;
            } catch (error) {
                return Response.error();
            }
        })());
        return;
    }

    const isStaticAsset = /\.(?:js|css|svg|webmanifest)$/i.test(url.pathname) ||
        url.pathname.endsWith("/index.html");

    if (isStaticAsset) {
        event.respondWith((async () => {
            const cache = await caches.open(CACHE);
            const cached = await cache.match(request, { ignoreSearch: true });
            if (cached) return cached;
            try {
                const response = await fetchWithTimeout(request);
                if (response && response.ok) {
                    const cacheKey = new Request(url.origin + url.pathname);
                    await cache.put(cacheKey, response.clone());
                }
                return response;
            } catch (error) {
                return Response.error();
            }
        })());
        return;
    }

    if (request.mode === "navigate") {
        event.respondWith((async () => {
            const cache = await caches.open(CACHE);
            try {
                const response = await fetchWithTimeout(request);
                if (response && response.ok) await cache.put("./index.html", response.clone());
                return response;
            } catch (error) {
                return (await cache.match("./index.html")) || Response.error();
            }
        })());
    }
});