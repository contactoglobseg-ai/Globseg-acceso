/**
 * La carpeta de fotos de las novedades, en Supabase Storage.
 *
 * Mismo criterio que `datos.js`: la clave de servicio vive como secreto del
 * Worker y el teléfono nunca la ve. La carpeta `fotos-novedades` es privada y
 * no tiene políticas, así que solo este Worker sube y lee. El navegador pide
 * la foto a `/api/novedades/<id>/foto` y el Worker se la entrega desde este
 * mismo dominio, por eso la política de contenido sigue sin orígenes de fuera.
 *
 * La clave va igual que en `datos.js`: siempre en `apikey`, y además como
 * Bearer solo si es de las antiguas (JWT). Las `sb_secret_…` no son un JWT.
 */

import { ErrorDatos } from './datos.js';

export const CARPETA_NOVEDADES = 'fotos-novedades';

function base(env) {
  if (!env.SUPABASE_URL) throw new ErrorDatos('Falta SUPABASE_URL para la carpeta de fotos', 500);
  return env.SUPABASE_URL.replace(/\/+$/, '') + '/storage/v1';
}

function cabeceras(env, extra = {}) {
  const clave = (env.SUPABASE_SERVICE_KEY || '').trim();
  if (!clave) throw new ErrorDatos('Falta configurar la conexión a Supabase', 500);
  const esJWT = clave.split('.').length === 3 && clave.startsWith('ey');
  return { apikey: clave, ...(esJWT ? { authorization: 'Bearer ' + clave } : {}), ...extra };
}

// Cada tramo de la ruta se codifica por separado: la barra separa carpetas.
const rutaSegura = (ruta) => ruta.split('/').map(encodeURIComponent).join('/');

/** Sube una foto JPEG. Lanza si la carpeta no la acepta. */
export async function subirFoto(env, carpeta, ruta, bytes) {
  const r = await fetch(`${base(env)}/object/${carpeta}/${rutaSegura(ruta)}`, {
    method: 'POST',
    headers: cabeceras(env, { 'content-type': 'image/jpeg', 'x-upsert': 'false' }),
    body: bytes,
  });
  if (r.ok) return;
  let datos = null;
  try { datos = JSON.parse(await r.text()); } catch { /* sin cuerpo */ }
  // Ya estaba: es un reintento desde la cola del teléfono, y la ruta lleva el
  // código de la novedad, así que la foto es la misma. No es un error.
  if (r.status === 409 || String(datos?.statusCode) === '409' ||
      /duplicate|already exists/i.test(datos?.error || datos?.message || '')) return;
  throw new ErrorDatos(
    `La carpeta de fotos respondió ${r.status}${datos?.message ? ': ' + datos.message : ''}`,
    r.status, datos);
}

/** Trae una foto para entregarla al navegador. null si no está. */
export async function leerFoto(env, carpeta, ruta) {
  const r = await fetch(`${base(env)}/object/${carpeta}/${rutaSegura(ruta)}`, {
    headers: cabeceras(env),
  });
  if (r.status === 404 || r.status === 400) return null;
  if (!r.ok) throw new ErrorDatos(`La carpeta de fotos respondió ${r.status}`, r.status);
  return r;
}
