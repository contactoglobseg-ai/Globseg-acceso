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

export const CATEGORIAS = ['novedad', 'ronda', 'incidencia', 'entrega_turno', 'otro'];

// Cómo se lee cada categoría en la pantalla. Vive acá y no en el HTML para que
// el servidor pueda nombrarlas igual cuando rechaza algo.
export const GLOSA_CATEGORIA = {
  novedad: 'Novedad',
  ronda: 'Ronda',
  incidencia: 'Incidencia',
  entrega_turno: 'Entrega de turno',
  otro: 'Otro',
};

const LARGO_TEXTO = 4000;

/**
 * Escribe una anotación.
 *
 * `corrige_id` convierte la anotación en la corrección de otra. No cambia la
 * vieja: la deja igual y la marca como corregida desde la vista.
 */
export async function escribir(env, cuerpo, quien) {
  const texto = String(cuerpo.texto ?? '').trim();
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
  const [fila] = await insertar(env, 'novedades', {
    instalacion_id: instalacionId,
    trabajador_id: quien.trabajador_id ?? null,
    quien: quien.usuario,
    quien_nombre: quien.nombre,
    cuando: ahora.toISOString(),
    fecha: fechaChile(ahora),
    categoria,
    texto,
    lat: numeroONulo(cuerpo.lat, -90, 90),
    lon: numeroONulo(cuerpo.lon, -180, 180),
    corrige_id: corrigeId,
  });

  await anotar(env, quien.usuario, 'novedad', fila.id,
    corrigeId ? 'corrigió una novedad' : 'escribió una novedad',
    `${instalacion.nombre} · ${GLOSA_CATEGORIA[categoria]}`);

  return { novedad: { ...fila, instalacion: instalacion.nombre } };
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
