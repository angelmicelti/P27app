// ================================================
// SERVICE WORKER — Gestor de Asuntos Propios
// ================================================
// DEBE COINCIDIR con APP_VERSION en index.html
const APP_VERSION = '2.12.0';
const CACHE_NAME = 'gestor-permisos-v' + APP_VERSION.replace(/\./g, '-');

// Recursos a pre-cachear durante la instalación
const PRECACHE_URLS = [
    './',
    './index.html',
    './manifest.json',
    './icons/icon-192.png',
    './icons/icon-512.png'
];

// Recursos externos que se cachean bajo demanda (Network First)
const CDN_PATTERNS = [
    /^https:\/\/cdn\.jsdelivr\.net\/npm\/bootstrap@5\.3\.2\//,
    /^https:\/\/unpkg\.com\/lucide@latest/,
    /^https:\/\/cdnjs\.cloudflare\.com\/ajax\/libs\/xlsx\/0\.18\.5\//,
    /^https:\/\/cdnjs\.cloudflare\.com\/ajax\/libs\/jspdf\/2\.5\.1\//,
    /^https:\/\/cdnjs\.cloudflare\.com\/ajax\/libs\/jspdf-autotable\/3\.5\.31\//,
    /^https:\/\/www\.gstatic\.com\/firebasejs\/10\.14\.1\//
];

// Firebase requiere POST y se gestiona solo (nunca cachear)
const NO_CACHE_PATTERNS = [
    /\/firebaseio\//,
    /\/googleapis\.com/,
    /\/firebase\.app/,
    /__session/
];

// ================================================
// INSTALACIÓN
// ================================================
self.addEventListener('install', (event) => {
    console.log('[SW] Instalando Service Worker v' + APP_VERSION);

    event.waitUntil(
        caches.open(CACHE_NAME)
            .then((cache) => {
                console.log('[SW] Pre-cacheando recursos locales...');
                return cache.addAll(PRECACHE_URLS).catch((err) => {
                    // Si falla algún recurso, continuamos — se cachearán bajo demanda
                    console.warn('[SW] Error pre-cacheando (continuando):', err);
                });
            })
            .then(() => {
                // Forzar activación inmediata (sin esperar a que se cierre la pestaña anterior)
                return self.skipWaiting();
            })
    );
});

// ================================================
// ACTIVACIÓN
// ================================================
self.addEventListener('activate', (event) => {
    console.log('[SW] Activando Service Worker v' + APP_VERSION);

    event.waitUntil(
        caches.keys().then((cacheNames) => {
            const deletePromises = cacheNames
                .filter((name) => name !== CACHE_NAME)
                .map((name) => {
                    console.log('[SW] Eliminando caché antigua:', name);
                    return caches.delete(name);
                });

            return Promise.all(deletePromises);
        }).then(() => {
            // Tomar control de todas las pestañas abiertas inmediatamente
            return self.clients.claim();
        }).then(() => {
            // Notificar a los clientes que el SW está activo
            return self.clients.matchAll().then((clients) => {
                clients.forEach((client) => {
                    client.postMessage({
                        type: 'SW_UPDATED',
                        version: APP_VERSION
                    });
                });
            });
        })
    );
});

// ================================================
// FETCH — Estrategia de caché inteligente
// ================================================
self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);

    // ── Solo gestionar requests GET ──
    if (event.request.method !== 'GET') return;

    // ── Nunca cachear Firebase (Firestore, Auth, etc.) ──
    if (NO_CACHE_PATTERNS.some(pattern => pattern.test(url.href))) return;

    // ── Recursos CDN externos: Network First con fallback a caché ──
    if (CDN_PATTERNS.some(pattern => pattern.test(url.href))) {
        event.respondWith(networkFirstWithCache(event.request, 'cdn-' + CACHE_NAME));
        return;
    }

    // ── Recursos locales (mismo origen): Stale While Revalidate ──
    // Sirve desde caché inmediatamente y actualiza en segundo plano
    if (url.origin === self.location.origin) {
        event.respondWith(staleWhileRevalidate(event.request));
        return;
    }

    // ── Otros recursos externos: Network First ──
    event.respondWith(networkFirstWithCache(event.request, CACHE_NAME));
});

// ================================================
// ESTRATEGIA: Stale While Revalidate
// Sirve desde caché si existe, y actualiza en paralelo
// ================================================
async function staleWhileRevalidate(request) {
    const cache = await caches.open(CACHE_NAME);
    const cachedResponse = await cache.match(request);

    // ── FALLBACK DE NAVEGACIÓN: Si es una petición de navegación
    //    (abrir la app desde escritorio, recargar, etc.) y no está
    //    en caché, intentar la red y si falla servir index.html ──
    if (!cachedResponse && request.mode === 'navigate') {
        try {
            const networkResponse = await fetch(request);
            if (networkResponse && (networkResponse.status === 200 || networkResponse.status === 304)) {
                cache.put(request, networkResponse.clone());
                return networkResponse;
            }
            // Si la red devuelve un error (404, 500, etc.), servir index.html desde caché
            const fallbackResponse = await cache.match('./index.html');
            if (fallbackResponse) {
                return fallbackResponse;
            }
            return networkResponse;
        } catch (error) {
            // Sin conexión: servir index.html desde caché
            const fallbackResponse = await cache.match('./index.html');
            if (fallbackResponse) {
                return fallbackResponse;
            }
            // Sin caché ni red: devolver respuesta offline
            return new Response(
                '<html><body><h1>Sin conexi&oacute;n</h1><p>Comprueba tu conexi&oacute;n a internet y vuelve a intentarlo.</p></body></html>',
                { headers: { 'Content-Type': 'text/html; charset=utf-8' } }
            );
        }
    }

    // Iniciar actualización en segundo plano (fire-and-forget)
    const fetchPromise = fetch(request)
        .then((networkResponse) => {
            if (networkResponse && networkResponse.status === 200) {
                cache.put(request, networkResponse.clone());
                // Notificar al cliente que se actualizó un recurso
                self.clients.matchAll().then((clients) => {
                    clients.forEach((client) => {
                        client.postMessage({
                            type: 'CACHE_UPDATED',
                            url: request.url
                        });
                    });
                });
            }
            return networkResponse;
        })
        .catch((err) => {
            console.warn('[SW] Error fetch en segundo plano:', err);
        });

    // Devolver caché si existe, si no esperar a la red
    if (cachedResponse) {
        return cachedResponse;
    }

    return fetchPromise;
}

// ================================================
// ESTRATEGIA: Network First con fallback a caché
// Para recursos CDN que se actualizan con menos frecuencia
// ================================================
async function networkFirstWithCache(request, cacheName) {
    try {
        const networkResponse = await fetch(request);
        if (networkResponse && networkResponse.status === 200) {
            const cache = await caches.open(cacheName);
            cache.put(request, networkResponse.clone());
        }
        return networkResponse;
    } catch (error) {
        // Sin red: buscar en caché
        const cache = await caches.open(cacheName);
        const cachedResponse = await cache.match(request);
        if (cachedResponse) {
            return cachedResponse;
        }
        // Sin red y sin caché: devolver respuesta offline genérica
        if (request.destination === 'document') {
            return new Response(
                '<html><body><h1>Sin conexi&oacute;n</h1><p>Comprueba tu conexi&oacute;n a internet y vuelve a intentarlo.</p></body></html>',
                { headers: { 'Content-Type': 'text/html; charset=utf-8' } }
            );
        }
        // Para otros recursos (scripts, css), simplemente fallar
        return new Response('', { status: 503, statusText: 'Offline' });
    }
}

// ================================================
// MENSAJES DEL CLIENTE
// ================================================
self.addEventListener('message', (event) => {
    if (!event.data || !event.data.type) return;

    switch (event.data.type) {
        case 'SKIP_WAITING':
            console.log('[SW] SKIP_WAITING recibido. Activando nuevo SW...');
            self.skipWaiting();
            break;

        case 'GET_VERSION':
            event.source.postMessage({
                type: 'VERSION_INFO',
                version: APP_VERSION,
                cacheName: CACHE_NAME
            });
            break;

        case 'CLEAR_CACHE':
            caches.keys().then((names) => {
                names.forEach((name) => caches.delete(name));
            }).then(() => {
                event.source.postMessage({ type: 'CACHE_CLEARED' });
            });
            break;
    }
});

// ================================================
// PUSH (preparado para el futuro)
// ================================================
self.addEventListener('push', (event) => {
    const data = event.data ? event.data.json() : {};
    const title = data.title || 'Gestor de Asuntos Propios';
    const options = {
        body: data.body || 'Tienes una notificación nueva',
        icon: './icons/icon-192.png',
        badge: './icons/icon-72.png',
        vibrate: [100, 50, 100],
        data: { url: data.url || './' }
    };

    event.waitUntil(
        self.registration.showNotification(title, options)
    );
});

self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    event.waitUntil(
        self.clients.openWindow(event.notification.data.url || './')
    );
});
