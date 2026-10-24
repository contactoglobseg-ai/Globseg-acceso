/* =============================================================================
 * COPIA de ADMINISTRACION/src/datos.js (repositorio globseg-adm), al 23-10-2026.
 *
 * Esta aplicación es un Worker aparte, así que no puede importar de allá. La
 * copia es a propósito y tiene un costo: si el archivo de allá cambia, hay que
 * traer el cambio acá a mano. Lo que difiere a propósito está marcado con
 * «DIFERENCIA» y explicado en el mismo lugar; todo lo demás es idéntico y
 * conviene que siga siéndolo.
 * ========================================================================== */

/**
 * Acceso a Supabase desde el Worker.
 *
 * Se usa la API REST (PostgREST) con la clave de servicio, que vive como
 * secreto del Worker y nunca en el repositorio. Esa clave salta las políticas
 * de la base a propósito: el control de quién ve qué está en el Worker, no en
 * la base, y las tablas quedan cerradas para cualquier otro acceso.
 */

// En producción basta SUPABASE_URL (la del proyecto). SUPABASE_REST existe
// solo para apuntar a una réplica local en las pruebas.
const raiz = (env) =>
  (env.SUPABASE_REST
    ? env.SUPABASE_REST.replace(/\/+$/, '')
    : env.SUPABASE_URL.replace(/\/+$/, '') + '/rest/v1') + '/';

export class ErrorDatos extends Error {
  constructor(mensaje, status, detalle) {
    super(mensaje);
    this.status = status;
    this.detalle = detalle;
  }
}

async function llamar(env, ruta, { metodo = 'GET', cuerpo, prefer } = {}) {
  if (!(env.SUPABASE_URL || env.SUPABASE_REST) || !env.SUPABASE_SERVICE_KEY) {
    throw new ErrorDatos('Falta configurar la conexión a Supabase', 500);
  }
  // Las claves antiguas de Supabase son JWT y van en apikey y en Authorization.
  // Las nuevas (sb_secret_...) no lo son: mandarlas como Bearer hace que el
  // servidor las rechace con "Invalid API key", porque ahí espera un JWT.
  const clave = env.SUPABASE_SERVICE_KEY.trim();

  // Una clave con caracteres que no son texto imprimible viene, casi siempre,
  // de copiar lo que el panel muestra enmascarado (sb_secret_44zUI••••) en vez
  // de usar su botón de copiar. Decirlo ahorra buscarlo en el error del servidor.
  if (/[^\x21-\x7E]/.test(clave)) {
    throw new ErrorDatos(
      'La clave de Supabase tiene caracteres inválidos: parece copiada de la ' +
      'versión enmascarada que muestra el panel. Use el botón de copiar.', 500);
  }

  const esJWT = clave.split('.').length === 3 && clave.startsWith('ey');

  const r = await fetch(raiz(env) + ruta, {
    method: metodo,
    headers: {
      apikey: clave,
      ...(esJWT ? { authorization: 'Bearer ' + clave } : {}),
      'content-type': 'application/json',
      ...(prefer ? { prefer } : {}),
    },
    body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo),
  });

  const texto = await r.text();
  let datos = null;
  if (texto) {
    try { datos = JSON.parse(texto); } catch { datos = texto; }
  }
  if (!r.ok) {
    throw new ErrorDatos(datos?.message || datos?.hint || `La base respondió ${r.status}`,
                         r.status, datos);
  }
  return datos;
}

/** Varias filas. `ruta` ya lleva los filtros de PostgREST. */
export const buscar = (env, ruta) => llamar(env, ruta);

/** Una fila o null. */
export async function primero(env, ruta) {
  const filas = await llamar(env, ruta.includes('limit=') ? ruta : ruta + '&limit=1');
  return Array.isArray(filas) && filas.length ? filas[0] : null;
}

/** Inserta una fila o un arreglo y devuelve lo insertado. */
export const insertar = (env, tabla, filas) =>
  llamar(env, tabla, { metodo: 'POST', cuerpo: filas, prefer: 'return=representation' });

/**
 * Inserta ignorando los que choquen con una clave única.
 * `conflicto` son las columnas de la restricción, separadas por coma.
 */
export const insertarSinDuplicar = (env, tabla, filas, conflicto) =>
  llamar(env, `${tabla}?on_conflict=${conflicto}`, {
    metodo: 'POST',
    cuerpo: filas,
    prefer: 'resolution=ignore-duplicates,return=representation',
  });

/** Actualiza las filas que calcen con el filtro. */
export const actualizar = (env, ruta, campos) =>
  llamar(env, ruta, { metodo: 'PATCH', cuerpo: campos, prefer: 'return=representation' });

/** Borra las filas que calcen con el filtro. El filtro es obligatorio: una
 *  ruta sin condición borraría la tabla entera. */
export const borrar = (env, ruta) => {
  if (!ruta.includes('=')) throw new ErrorDatos('Borrado sin filtro: se rechaza', 500);
  return llamar(env, ruta, { metodo: 'DELETE' });
};

/** Escribe en la bitácora sin hacer fallar la operación principal. */
export async function anotar(env, quien, entidad, entidad_id, accion, detalle) {
  try {
    await insertar(env, 'bitacora', {
      quien, entidad, entidad_id: entidad_id ?? null, accion, detalle: detalle ?? null,
    });
  } catch (e) {
    // La bitácora es rastro, no parte del trámite: si falla, el trámite sigue.
    console.error('No se pudo anotar en la bitácora:', e.message);
  }
}
