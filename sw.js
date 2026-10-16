// sw.js — Service Worker nativo: caché offline de la App Shell
const CACHE_NAME = 'presupuesto-shell-v4';

const APP_SHELL = [
  './',
  './index.html',
  './login.html',
  './register.html',
  './dashboard.html',
  './analytics.html',
  './manifest.webmanifest',
  './styles/main.css',
  './styles/auth.css',
  './styles/dashboard.css',
  './js/supabaseClient.js',
  './js/guard.js',
  './js/utils/authGuard.js',
  './js/services/authService.js',
  './js/services/budgetService.js',
  './js/services/categoryService.js',
  './js/controllers/loginController.js',
  './js/controllers/registerController.js',
  './js/controllers/dashboardController.js',
  './js/controllers/analyticsController.js',
  './js/utils/helpers.js',
  './js/utils/chartManager.js',
  './js/utils/csvExport.js',
  './js/utils/pdfExport.js'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // 1. Filtrar esquemas no soportados por la API Cache
  if (!url.protocol.startsWith('http')) return;

  // 2. Nunca cachear llamadas a la API de Supabase (datos siempre frescos)
  if (url.hostname.endsWith('.supabase.co')) return;

  // 3. Mismo origen: cache-first con actualización en segundo plano
  if (url.origin === self.location.origin) {
    event.respondWith(
      caches.match(request).then((cached) => {
        const network = fetch(request)
          .then((response) => {
            if (response?.ok && response.type === 'basic') {
              const copy = response.clone();
              caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
            }
            return response;
          })
          .catch(() => cached);
        return cached ?? network;
      })
    );
    return;
  }

  // 4. CDN ESM (librerías externas): network-first con respaldo en caché
  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response?.ok) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
        }
        return response;
      })
      .catch(() => caches.match(request))
  );
});