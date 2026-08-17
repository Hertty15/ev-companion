/**
 * EV Companion Service Worker
 * Provides offline caching and background sync
 */

const CACHE_NAME = 'ev-companion-v1';
const STATIC_ASSETS = [
    '/',
    '/static/css/style.css',
    '/static/js/app.js',
    '/static/manifest.json',
    '/static/icons/icon.svg'
];

// Install - cache static assets
self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then(cache => cache.addAll(STATIC_ASSETS))
            .then(() => self.skipWaiting())
    );
});

// Activate - clean old caches
self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then(cacheNames => {
            return Promise.all(
                cacheNames
                    .filter(name => name !== CACHE_NAME)
                    .map(name => caches.delete(name))
            );
        }).then(() => self.clients.claim())
    );
});

// Fetch - serve from cache or network
self.addEventListener('fetch', (event) => {
    const { request } = event;

    // Skip non-GET requests and API calls
    if (request.method !== 'GET' || request.url.includes('/api/') || request.url.includes('/auth/') || request.url.includes('/chat/')) {
        return;
    }

    event.respondWith(
        caches.match(request).then(cached => {
            if (cached) {
                // Return cached version and update in background
                fetch(request).then(response => {
                    caches.open(CACHE_NAME).then(cache => {
                        cache.put(request, response.clone());
                    });
                }).catch(() => {});
                return cached;
            }

            // Fetch and cache
            return fetch(request).then(response => {
                if (response.ok && request.url.startsWith(self.location.origin)) {
                    const clone = response.clone();
                    caches.open(CACHE_NAME).then(cache => cache.put(request, clone));
                }
                return response;
            }).catch(() => {
                // Offline fallback for navigation requests
                if (request.mode === 'navigate') {
                    return caches.match('/');
                }
                return new Response('Offline', { status: 503 });
            });
        })
    );
});
