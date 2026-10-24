/* =============================================================================
 * COPIA de ADMINISTRACION/src/seguridad.js (repositorio globseg-adm), al 23-10-2026.
 *
 * Esta aplicación es un Worker aparte, así que no puede importar de allá. La
 * copia es a propósito y tiene un costo: si el archivo de allá cambia, hay que
 * traer el cambio acá a mano. Lo que difiere a propósito está marcado con
 * «DIFERENCIA» y explicado en el mismo lugar; todo lo demás es idéntico y
 * conviene que siga siéndolo.
 * ========================================================================== */

/**
 * Lo que el navegador tiene que recibir en cada respuesta.
 *
 * Hasta el 15-10-2026 el Worker contestaba igual por http que por https: la
 * página de ingreso, con su campo de contraseña, se entregaba en claro. Safari
 * marca eso como conexión no segura, no autocompleta la clave desde el llavero
 * y avisa antes de dejar escribirla; de ahí venía el «no me deja entrar».
 * El problema de fondo no es el aviso: por http la contraseña y la cookie de
 * sesión viajan a la vista de cualquiera en la misma red.
 *
 * Por eso acá hay dos cosas:
 *  - `redireccionHttps`, que no deja que una petición en claro llegue a ver
 *    nada, y la cabecera HSTS, que le dice al navegador que no vuelva a
 *    intentarlo en claro nunca más (ni siquiera la primera petición).
 *  - `cabecerasSeguridad`, que acota lo que la página puede cargar y ejecutar,
 *    y que acá además le abre la cámara, que es lo que lee el QR de la cédula.
 */

// Un año. Sin `preload`: entrar a la lista de los navegadores es un camino de
// ida y obliga a mantener https en todo seggarridos.com para siempre.
const HSTS = 'max-age=31536000; includeSubDomains';

/** En pruebas locales se trabaja por http y no hay nada que proteger. */
const esLocal = (host) =>
  host === 'localhost' || host === '127.0.0.1' || host.endsWith('.localhost');

/**
 * El esquema que usó el visitante. Detrás de Cloudflare la petición llega al
 * Worker tal como vino, así que `url.protocol` alcanza; `cf-visitor` se mira
 * igual por si algún día hay un proxy delante que termine el TLS antes.
 */
function enClaro(request, url) {
  const host = url.hostname.toLowerCase();
  if (esLocal(host)) return false;
  const visitante = request.headers.get('cf-visitor') || '';
  if (visitante.includes('"scheme":"http"')) return true;
  return url.protocol === 'http:';
}

/**
 * Devuelve la redirección a https, o null si la petición ya venía segura.
 *
 * 301 y no 302: es permanente y el navegador se la guarda, así que la próxima
 * vez ni siquiera sale a la red en claro.
 */
export function redireccionHttps(request, url) {
  if (!enClaro(request, url)) return null;
  const destino = new URL(url);
  destino.protocol = 'https:';
  return new Response(null, {
    status: 301,
    headers: { location: destino.toString(), 'strict-transport-security': HSTS },
  });
}

/* DIFERENCIA: una sola política, y es la cerrada.
 *
 * El control de acceso no carga nada de afuera: ni tipografías de Google ni
 * librerías de cdnjs. El lector de QR va servido desde este mismo dominio
 * (`public/jsqr.js`) justamente para poder dejar esta política así de corta.
 *
 * No es purismo. Esta pantalla se abre desde el teléfono de un guardia, en la
 * caseta de un parque fotovoltaico, por la red que haya —muchas veces la de
 * datos de su propio teléfono, a veces una wifi del mandante— y lo que se
 * teclea adentro es el RUN y el nombre de cada persona que entra. No hay un
 * solo origen de fuera que tenga por qué estar en el medio de eso. Además,
 * sin dependencias externas el lector de QR sigue andando con la señal mala,
 * que es la condición normal del lugar donde se usa.
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  // blob: es el cuadro de video de la cámara y el PNG de la firma; data: son
  // las dos cosas cuando el navegador prefiere entregarlas así.
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

/**
 * Cabeceras para la página. `frame-ancestors 'none'` y X-Frame-Options dicen
 * lo mismo para navegadores nuevos y viejos: esta página no se muestra dentro
 * de otro sitio, que es como se engaña a alguien para que haga clic donde no
 * cree.
 *
 * DIFERENCIA: acá la cámara va en `camera=(self)`, al revés que en las otras
 * tres páginas del sistema, donde está cerrada. Es la única que lee el QR de
 * una cédula, y sin este permiso `getUserMedia` falla sin decir por qué: el
 * botón de escanear quedaría muerto y nadie sabría que la culpa es de una
 * cabecera. La geolocalización va igual que en el libro de asistencia, porque
 * una novedad y un evento valen por dónde se registraron.
 *
 * El micrófono sigue cerrado: acá no se graba a nadie.
 */
export function cabecerasSeguridad() {
  return {
    'strict-transport-security': HSTS,
    'content-security-policy': CSP,
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'strict-origin-when-cross-origin',
    'permissions-policy':
      'camera=(self), geolocation=(self), microphone=(), interest-cohort=()',
  };
}

/**
 * Agrega `no-transform` al `cache-control` que ya traiga la respuesta.
 *
 * Cloudflare reescribe el HTML al vuelo para meterle la baliza de Web
 * Analytics, y las dos CSP de acá arriba la bloquean —la de asistencia a
 * propósito, porque esa página no carga nada de afuera—. El resultado era un
 * error rojo en la consola en cada carga, de algo que además nunca iba a
 * funcionar. `no-transform` le dice que no toque la respuesta, y entonces no
 * hay nada que bloquear.
 *
 * Se **agrega** en vez de reemplazar: el servidor de archivos entrega las
 * páginas con `public, max-age=0, must-revalidate`, y escribir encima un
 * `public, no-transform` pelado quitaría el `must-revalidate`. Sin él, el
 * navegador puede quedarse con la página vieja por su cuenta, y un despliegue
 * dejaría de llegarle a quien ya la tenía abierta.
 */
function sinTransformar(cacheControl) {
  if (!cacheControl) return 'no-transform';
  if (/(^|,)\s*no-transform\s*($|,)/i.test(cacheControl)) return cacheControl;
  return cacheControl + ', no-transform';
}

/**
 * Copia una respuesta agregándole las cabeceras, sin tocar su cuerpo.
 *
 * Solo lo usan las páginas: la API arma sus propias respuestas con
 * `cache-control: no-store` y no pasa por acá.
 */
export function conCabeceras(respuesta, cabeceras) {
  const r = new Response(respuesta.body, respuesta);
  for (const [k, v] of Object.entries(cabeceras)) r.headers.set(k, v);
  r.headers.set('cache-control', sinTransformar(r.headers.get('cache-control')));
  return r;
}

/**
 * Solo la cabecera HSTS, para las respuestas de la API, que no son páginas y
 * no necesitan el resto. Importa igual: si alguien llama a la API por http una
 * sola vez, el navegador ya no vuelve a intentarlo en claro.
 */
export const soloHttps = () => ({ 'strict-transport-security': HSTS });
