/* Service worker de acceso.seggarridos.com
 *
 * Existe para dos cosas: que el teléfono deje INSTALAR la página como app, y
 * que la pantalla ABRA aunque no haya señal (así el guardia puede dejar una
 * novedad en la cola del teléfono, que se envía cuando vuelve la conexión).
 *
 * Guarda solo la pantalla: el HTML, los estilos, los scripts y los íconos.
 * NUNCA guarda nada de /api/: accesos, novedades, fotos, sesión y firmas van
 * siempre al servidor, para que nadie vea ni firme sobre datos viejos.
 *
 * Al cambiar cualquier archivo de public/, subir VERSION: los teléfonos bajan
 * la versión nueva en la siguiente apertura con señal.
 */
const VERSION = 'acceso-v8';
const PANTALLA = [
  '/', '/apariencia.css', '/acceso.css', '/apariencia.js', '/firma.js',
  '/logo.png', '/manifest.json',
  '/iconos/icono-192.png', '/iconos/icono-512.png', '/iconos/icono-maskable-512.png',
  '/iconos/apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(PANTALLA)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((ks) => Promise.all(ks.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.startsWith('/api/')) return;            // datos: siempre a la red

  // La página: primero la red, para recibir los cambios; sin señal, la guardada.
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req)
      .then((r) => {
        if (r.ok) { const copia = r.clone(); caches.open(VERSION).then((c) => c.put('/', copia)); }
        return r;
      })
      .catch(() => caches.match('/')));
    return;
  }

  // Estilos, scripts e íconos: la copia guardada al tiro, y se refresca detrás.
  e.respondWith(caches.open(VERSION).then(async (c) => {
    const guardado = await c.match(req);
    const red = fetch(req).then((r) => { if (r.ok) c.put(req, r.clone()); return r; })
      .catch(() => guardado);
    return guardado || red;
  }));
});
