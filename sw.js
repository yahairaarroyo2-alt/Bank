const CACHE = 'bank-v16';
// Caché aparte para los CDN externos (jsPDF, Google Fonts) que la app necesita
// para generar PDFs offline — se guarda con su propio nombre para no mezclarse
// con el caché de la app (que se borra completo en cada actualización).
const CDN_CACHE = 'bank-cdn-v1';
const CDN_HOSTS = ['cdnjs.cloudflare.com', 'fonts.googleapis.com', 'fonts.gstatic.com', 'www.gstatic.com'];
const ASSETS = [
  './',
  './index.html',
  './icon.png',
  './icon-192.png',
  './icon-maskable.png'
];

self.addEventListener('install', e => {
  // Activar el nuevo SW de inmediato, sin esperar a que se cierren las pestañas
  self.skipWaiting();
  e.waitUntil(
    caches.open(CACHE).then(c => {
      // Add local assets, skip external ones
      return Promise.allSettled(
        ASSETS.map(url => c.add(url))
      );
    })
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE && k !== CDN_CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim()) // tomar control de las pestañas abiertas ya mismo
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;

  let url;
  try { url = new URL(req.url); } catch { return; }

  // jsPDF / Google Fonts / SDK de Firebase (www.gstatic.com/firebasejs/...) → CACHE
  // PRIMERO: son archivos versionados en la URL, seguros de cachear indefinidamente.
  // Sin el SDK cacheado, firebase.initializeApp() reventaba offline (o si el navegador
  // ya había limpiado su caché HTTP normal) y la app ni siquiera arrancaba. Las
  // LLAMADAS de Firestore/Auth (a firestore.googleapis.com, etc.) sí necesitan red
  // real — esas van por otro host y no entran acá.
  if (CDN_HOSTS.includes(url.hostname)) {
    e.respondWith(
      caches.open(CDN_CACHE).then(c =>
        c.match(req).then(cached => {
          if (cached) return cached;
          return fetch(req).then(res => {
            if (res.ok) c.put(req, res.clone());
            return res;
          }).catch(() => cached);
        })
      )
    );
    return;
  }

  // No interceptar otros orígenes (Firebase, etc.): dejarlos pasar directo.
  if (url.origin !== location.origin) return;

  // HTML / navegación → CACHÉ PRIMERO + revalidar en segundo plano (stale-while-
  // revalidate). Antes era red-primero con tope de 3s: cada apertura, con señal mala,
  // se quedaba hasta 3s mirando el splash aunque el HTML ya estuviera cacheado. Ahora
  // abre al instante con lo que ya hay; la descarga nueva sigue de fondo y queda lista
  // para la PRÓXIMA apertura (self.skipWaiting()+clients.claim() de arriba ya se
  // encargan de que el SW nuevo tome el control solo). Sin caché todavía (primera
  // visita) sí espera la red, con el mismo timeout de antes para no colgarse.
  const isHTML = req.mode === 'navigate' ||
                 (req.headers.get('accept') || '').includes('text/html');
  if (isHTML) {
    e.respondWith(
      caches.match('./index.html').then(cached => {
        // Descarga + guardado en caché, SIN tope de tiempo — esta es la que hay que dejar
        // terminar de verdad (ver e.waitUntil más abajo).
        const fetchAndCache = fetch(req).then(res => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then(c => c.put('./index.html', copy)).catch(() => {});
          }
          return res;
        });
        // Con tope de 3s — solo para la PRIMERA visita (sin caché todavía), así no se
        // cuelga esperando una red lenta. Con caché ya no hace falta: se responde de una.
        const networkUpdate = Promise.race([
          fetchAndCache,
          new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000))
        ]).catch(() => null);
        if (cached) {
          // e.waitUntil mantiene el Service Worker vivo hasta que fetchAndCache TERMINE
          // de verdad — sin esto, el navegador daba la petición por "atendida" apenas
          // se devolvía `cached` y podía apagar el SW a mitad de la descarga/guardado de
          // fondo, dejando la actualización a medias (index.html nunca quedaba guardado,
          // así que la próxima apertura seguía sirviendo la versión vieja).
          e.waitUntil(fetchAndCache.catch(() => {}));
          return cached;
        }
        return networkUpdate.then(res => res || new Response('Offline', { status: 503, headers: { 'Content-Type': 'text/plain' } }));
      })
    );
    return;
  }

  // Otros recursos del mismo origen (icono, etc.) → CACHE PRIMERO.
  e.respondWith(
    caches.match(req).then(cached =>
      cached || fetch(req).catch(() =>
        new Response('Offline — recurso no disponible', {
          status: 503,
          headers: { 'Content-Type': 'text/plain' }
        })
      )
    )
  );
});
