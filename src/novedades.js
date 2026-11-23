/**
 * El libro de novedades del puesto.
 *
 * Es el cuaderno de la caseta, y vale por lo mismo que vale el de papel: que
 * lo escrito queda. Por eso acá no hay editar ni borrar. Una anotación mal
 * hecha se corrige escribiendo otra que apunta a ella, y las dos quedan a la
 * vista con su hora.
 *
 * Esa es toda la regla del archivo. Lo demás es ponerle la hora del servidor y
 * el nombre de quien escribe, que son las dos cosas que el guardia no tiene
 * que poder elegir.
 */

import { buscar, primero, insertar, anotar } from './datos.js';
import { fechaChile, esFecha } from './fechas.js';
import { subirFoto, leerFoto, CARPETA_NOVEDADES } from './almacen.js';

export const CATEGORIAS = ['novedad', 'ronda', 'incidencia', 'entrega_turno', 'otro', 'sin_complejidades'];

// Cómo se lee cada categoría en la pantalla. Vive acá y no en el HTML para que
// el servidor pueda nombrarlas igual cuando rechaza algo.
export const GLOSA_CATEGORIA = {
  novedad: 'Novedad',
  ronda: 'Ronda',
  incidencia: 'Incidente',
  entrega_turno: 'Entrega de turno',
  otro: 'Otro',
  sin_complejidades: 'Sin complejidades',
};

// «Sin complejidades» es la foto de control del turno: no hay nada que
// contar, así que la observación no es obligatoria y, si viene vacía, se
// escribe esta. La base exige texto en toda anotación.
const TEXTO_SIN_COMPLEJIDADES = 'Turno realizado sin complejidades que informar.';

const LARGO_TEXTO = 4000;

// La foto llega desde el teléfono ya reducida a 800 px (unos 100 KB). El tope
// es holgado a propósito: lo que se quiere frenar es un archivo que no es una
// foto de la app, no una foto con mucho detalle.
const MAX_BYTES_FOTO = 1.5 * 1024 * 1024;

/**
 * ¿Ya se aplicó la migración de las fotos (20261123120000_novedades_fotos.sql)?
 *
 * Mismo criterio que `tablasListas()` en index.js: mientras falte, el libro
 * sigue funcionando igual que antes y la novedad se guarda sin foto, con un
 * aviso que lo dice. Perder la anotación por una columna que falta sería peor
 * que perder la foto.
 */
let columnasFotoOk = false;
export async function columnasFotoListas(env) {
  if (columnasFotoOk) return true;
  try {
    await buscar(env, 'novedades?select=foto_ruta,exactitud_m&limit=1');
    columnasFotoOk = true;
  } catch {
    return false;
  }
  return true;
}

/** `data:image/jpeg;base64,...` → bytes, o null si no es un JPEG de verdad. */
function bytesDeFoto(dataUrl) {
  const m = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
  if (!m) return null;
  let bin;
  try { bin = atob(m[1]); } catch { return null; }
  if (bin.length > MAX_BYTES_FOTO) return { demasiado: true };
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  // Los tres primeros bytes de todo JPEG. El encabezado del data URL lo
  // escribe cualquiera; esto no.
  if (!(bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)) return null;
  return { bytes };
}

/**
 * Escribe una anotación.
 *
 * `corrige_id` convierte la anotación en la corrección de otra. No cambia la
 * vieja: la deja igual y la marca como corregida desde la vista.
 */
export async function escribir(env, cuerpo, quien) {
  let texto = String(cuerpo.texto ?? '').trim();
  if (!texto && cuerpo.categoria === 'sin_complejidades') texto = TEXTO_SIN_COMPLEJIDADES;
  if (!texto) return { error: 'Escriba la novedad', status: 400 };
  if (texto.length > LARGO_TEXTO) {
    return { error: `La novedad no puede pasar de ${LARGO_TEXTO} caracteres`, status: 400 };
  }

  const instalacionId = Number(cuerpo.instalacion_id);
  if (!Number.isInteger(instalacionId) || instalacionId <= 0) {
    return { error: 'Elija de qué instalación es la novedad', status: 400 };
  }
  const instalacion = await primero(env,
    `instalaciones?select=id,nombre&id=eq.${instalacionId}`);
  if (!instalacion) return { error: 'Esa instalación no existe', status: 404 };

  const categoria = CATEGORIAS.includes(cuerpo.categoria) ? cuerpo.categoria : 'novedad';

  let corrigeId = null;
  if (cuerpo.corrige_id != null && cuerpo.corrige_id !== '') {
    const n = Number(cuerpo.corrige_id);
    const vieja = Number.isInteger(n) && n > 0
      ? await primero(env, `novedades?select=id,corrige_id&id=eq.${n}`) : null;
    if (!vieja) return { error: 'La novedad que quiere corregir no existe', status: 404 };
    // Una corrección de una corrección encadenaría una historia que después
    // nadie puede leer en orden. La segunda corrección corrige a la original,
    // que es lo que de verdad se está arreglando.
    corrigeId = vieja.corrige_id || vieja.id;
  }

  const ahora = new Date();
  const fecha = fechaChile(ahora);

  // La foto, si viene. Se sube ANTES de escribir la anotación para que la
  // anotación nunca apunte a una foto que no está. Si algo falla con la foto,
  // la novedad se escribe igual y se avisa: el libro no se detiene por eso.
  const extra = {};
  let aviso = null;
  if (cuerpo.foto) {
    const foto = bytesDeFoto(cuerpo.foto);
    if (!foto) return { error: 'La foto no es una imagen JPEG válida', status: 400 };
    if (foto.demasiado) return { error: 'La foto pesa demasiado (máximo 1,5 MB)', status: 413 };
    if (!(await columnasFotoListas(env))) {
      aviso = 'La novedad quedó anotada, pero SIN la foto: falta aplicar en Supabase ' +
              'la migración 20261123120000_novedades_fotos.sql.';
    } else {
      const ruta = `${instalacionId}/${fecha}/${crypto.randomUUID()}.jpg`;
      try {
        await subirFoto(env, CARPETA_NOVEDADES, ruta, foto.bytes);
        extra.foto_ruta = ruta;
        extra.foto_bytes = foto.bytes.length;
      } catch (e) {
        console.error('No se pudo subir la foto de la novedad:', e.message);
        aviso = 'La novedad quedó anotada, pero la foto no se pudo guardar. Avise a la oficina.';
      }
    }
  }
  if (await columnasFotoListas(env)) {
    const exactitud = numeroONulo(cuerpo.exactitud_m, 0, 1e6);
    if (exactitud !== null) extra.exactitud_m = Math.round(exactitud);
  }

  const [fila] = await insertar(env, 'novedades', {
    instalacion_id: instalacionId,
    trabajador_id: quien.trabajador_id ?? null,
    quien: quien.usuario,
    quien_nombre: quien.nombre,
    cuando: ahora.toISOString(),
    fecha,
    categoria,
    texto,
    lat: numeroONulo(cuerpo.lat, -90, 90),
    lon: numeroONulo(cuerpo.lon, -180, 180),
    corrige_id: corrigeId,
    ...extra,
  });

  await anotar(env, quien.usuario, 'novedad', fila.id,
    corrigeId ? 'corrigió una novedad' : 'escribió una novedad',
    `${instalacion.nombre} · ${GLOSA_CATEGORIA[categoria]}${extra.foto_ruta ? ' · con foto' : ''}`);

  return { novedad: { ...fila, instalacion: instalacion.nombre }, aviso };
}

/**
 * La foto de una novedad, entregada desde este mismo dominio.
 *
 * La ve quien puede ver el libro, que es cualquiera con sesión: es la misma
 * regla que el listado. Si eso cambia allá, cambia acá.
 */
export async function foto(env, id) {
  const n = Number(id);
  if (!Number.isInteger(n) || n <= 0) return { error: 'Foto no encontrada', status: 404 };
  if (!(await columnasFotoListas(env))) return { error: 'Foto no encontrada', status: 404 };
  const fila = await primero(env, `novedades?select=foto_ruta&id=eq.${n}`);
  if (!fila || !fila.foto_ruta) return { error: 'Foto no encontrada', status: 404 };
  const r = await leerFoto(env, CARPETA_NOVEDADES, fila.foto_ruta);
  if (!r) return { error: 'La foto no está en la carpeta', status: 404 };
  return {
    respuesta: new Response(r.body, {
      headers: {
        'content-type': 'image/jpeg',
        // Privada: no se guarda en cachés compartidos. Una hora en el teléfono.
        'cache-control': 'private, max-age=3600',
        'x-content-type-options': 'nosniff',
      },
    }),
  };
}

function numeroONulo(v, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) return null;
  return n;
}

/**
 * El listado. Sin fechas, el día de hoy.
 *
 * Va de la más nueva a la más vieja: en una caseta lo que se mira al llegar es
 * lo último que pasó, no lo primero del turno anterior.
 */
export async function listar(env, p) {
  const filtros = [];

  const inst = Number(p.get('instalacion'));
  if (Number.isInteger(inst) && inst > 0) filtros.push(`instalacion_id=eq.${inst}`);

  const desde = esFecha(p.get('desde')) ? p.get('desde') : fechaChile();
  const hasta = esFecha(p.get('hasta')) ? p.get('hasta') : desde;
  filtros.push(`fecha=gte.${desde}`, `fecha=lte.${hasta}`);

  if (CATEGORIAS.includes(p.get('categoria'))) {
    filtros.push(`categoria=eq.${p.get('categoria')}`);
  }

  const tope = Math.min(Math.max(Number(p.get('tope')) || 200, 1), 1000);
  const filas = await buscar(env,
    `v_novedades?select=*&${filtros.join('&')}&order=cuando.desc&limit=${tope}`);

  return { novedades: filas, desde, hasta, tope_alcanzado: filas.length >= tope };
}

/** Cuántas novedades se escribieron en una instalación entre dos instantes. */
export async function contarEntre(env, instalacionId, desdeISO, hastaISO) {
  const filas = await buscar(env,
    `novedades?select=id&instalacion_id=eq.${instalacionId}` +
    `&cuando=gte.${desdeISO}&cuando=lte.${hastaISO}&limit=500`);
  return Array.isArray(filas) ? filas.length : 0;
}

/**
 * Quién marcó turno en una instalación un día dado, y la víspera para cubrir
 * el turno de noche que empezó el día anterior. Es el cruce que la revisión
 * de la oficina pone al lado de cada novedad: qué guardia estaba cuando se
 * escribió. Lee `marcas` y `trabajadores`, que son del libro de asistencia:
 * acá solo se leen, nunca se escriben.
 */
export async function turnoDelDia(env, p) {
  const inst = Number(p.get('instalacion'));
  if (!Number.isInteger(inst) || inst <= 0) return { error: 'Falta la instalación', status: 400 };
  const fecha = esFecha(p.get('fecha')) ? p.get('fecha') : fechaChile();
  const vispera = new Date(Date.parse(fecha + 'T12:00:00Z') - 864e5).toISOString().slice(0, 10);
  const marcas = await buscar(env,
    `marcas?select=trabajador_id,tipo,cuando,fecha&instalacion_id=eq.${inst}` +
    `&fecha=gte.${vispera}&fecha=lte.${fecha}&order=cuando.asc&limit=500`);
  const ids = [...new Set(marcas.map((m) => m.trabajador_id))];
  const nombres = ids.length
    ? Object.fromEntries((await buscar(env, `trabajadores?select=id,nombre&id=in.(${ids.join(',')})`))
        .map((t) => [t.id, t.nombre]))
    : {};
  const porPersona = {};
  for (const m of marcas) {
    const k = `${m.trabajador_id}|${m.fecha}`;
    porPersona[k] ??= { nombre: nombres[m.trabajador_id] || '—', fecha: m.fecha, marcas: [] };
    porPersona[k].marcas.push({ tipo: m.tipo, cuando: m.cuando });
  }
  return { fecha, vispera, turnos: Object.values(porPersona) };
}
