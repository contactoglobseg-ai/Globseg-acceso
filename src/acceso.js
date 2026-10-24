/**
 * Accesos: quién y qué entra y sale de una instalación.
 *
 * Una fila por ingreso, venga la persona a pie o manejando. El detalle de por
 * qué no hay una tabla de vehículos aparte está en la migración; acá importa
 * la consecuencia: el registro de vehículos es este mismo listado filtrado por
 * los que traen patente, y «quién está adentro» es una sola consulta.
 *
 * Dos reglas que gobiernan todo el archivo:
 *
 *  - **Antes que perder el registro, se registra con un aviso.** Un repartidor
 *    sin cédula, un RUN con el dígito verificador malo, una patente escrita
 *    raro: nada de eso impide anotar el ingreso. Lo que se devuelve es el
 *    registro más un `aviso` que la pantalla muestra en ámbar. El ingreso ya
 *    ocurrió y negarse a escribirlo no lo deshace; lo único que haría es que
 *    el guardia lo anote en un papel que nadie va a leer.
 *  - **Nada se edita ni se borra.** La salida se marca escribiendo
 *    `salida_en`, que es la única columna que se escribe después.
 */

import { buscar, primero, insertar, actualizar, anotar } from './datos.js';
import { normalizarRut, dvCorrecto, formatearRut } from './rut.js';
import { leerCedula } from './cedula.js';
import { fechaChile, esFecha } from './fechas.js';

/** Cuántos días se guardan el RUN, el nombre y la patente de un visitante. */
export const DIAS_RETENCION = 365;

// Lo que cabe en cada campo. No es paranoia: el campo de la pantalla no limita
// nada y lo que llega es lo que mandó un navegador.
const LARGOS = {
  nombre: 120, empresa: 120, motivo: 120, a_quien_visita: 120,
  patente: 12, vehiculo_tipo: 40, vehiculo_detalle: 80, nota: 500,
};

const TIPOS_VEHICULO = ['auto', 'camioneta', 'camión', 'furgón', 'bus',
                        'moto', 'maquinaria', 'otro'];

/** Recorta y limpia un texto, o devuelve null si quedó vacío. */
function texto(valor, largo) {
  const t = String(valor ?? '').replace(/\s+/g, ' ').trim();
  if (!t) return null;
  return t.slice(0, largo);
}

/**
 * La patente, sin puntos ni guiones y en mayúsculas.
 *
 * Se normaliza por lo mismo que el RUT: si una se guarda «KXKX-12» y otra
 * «kxkx12», el mismo camión aparece como dos y buscar por patente —que es
 * justo lo que se hace cuando el cliente pregunta por un vehículo— no
 * encuentra la mitad.
 *
 * No se valida el formato. Las patentes chilenas tienen tres formas distintas
 * según el año y existen las extranjeras y las provisorias de papel; rechazar
 * lo que no calce con un molde dejaría sin registrar un camión argentino.
 */
export function normalizarPatente(valor) {
  const t = String(valor ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return t ? t.slice(0, 12) : null;
}

/** `KXKX12` -> `KXKX·12`, solo para mostrar. */
export const patenteLinda = (p) =>
  (typeof p === 'string' && p.length === 6) ? `${p.slice(0, 4)}·${p.slice(4)}` : (p || '');

/**
 * Qué se guarda del documento que presentó el visitante.
 *
 * `qr` es el texto crudo que leyó la cámara. Se vuelve a leer acá y lo que
 * manda es este resultado, no lo que el navegador haya dicho que leyó: entre
 * la cámara y esta función hay una página web, y una página web se puede
 * cambiar desde la consola del teléfono.
 */
function documentoDe(cuerpo) {
  if (cuerpo.qr) {
    const c = leerCedula(cuerpo.qr);
    if (c.ok) {
      return {
        run: c.run,
        origen_run: 'qr',
        documento_tipo: c.tipo,
        documento_serie: c.serie,
        documento_vence: c.vence,
        lectura: c,
      };
    }
    // El código no se entendió. No es un error que detenga nada: se sigue con
    // lo que haya escrito el guardia, y se dice qué pasó con el código.
    return { ...documentoEscrito(cuerpo), aviso_qr: c.motivo };
  }
  return documentoEscrito(cuerpo);
}

function documentoEscrito(cuerpo) {
  const run = normalizarRut(cuerpo.run);
  return {
    run,
    origen_run: run ? 'manual' : 'sin_documento',
    documento_tipo: null,
    documento_serie: null,
    documento_vence: null,
    lectura: null,
  };
}

/**
 * Registra un ingreso.
 *
 * `quien` es `{ usuario, nombre }` de la cuenta que lo está escribiendo.
 */
export async function registrarIngreso(env, cuerpo, quien) {
  const instalacionId = Number(cuerpo.instalacion_id);
  if (!Number.isInteger(instalacionId) || instalacionId <= 0) {
    return { error: 'Elija a qué instalación está entrando', status: 400 };
  }
  const instalacion = await primero(env,
    `instalaciones?select=id,nombre&id=eq.${instalacionId}`);
  if (!instalacion) return { error: 'Esa instalación no existe', status: 404 };

  const doc = documentoDe(cuerpo);
  const nombre = texto(cuerpo.nombre, LARGOS.nombre);
  const patente = normalizarPatente(cuerpo.patente);

  // Lo mínimo para que la fila signifique algo: o se sabe quién es, o se sabe
  // qué vehículo es. Una fila sin RUN, sin nombre y sin patente diría «entró
  // algo», que no sirve ni para contar.
  if (!doc.run && !nombre && !patente) {
    return {
      error: 'Escriba al menos el nombre, el RUN o la patente de lo que entra',
      status: 400,
    };
  }

  const avisos = [];
  if (doc.aviso_qr) avisos.push(doc.aviso_qr + '. Se registró con lo escrito a mano.');
  if (doc.run && !dvCorrecto(doc.run)) {
    avisos.push(`El RUN ${formatearRut(doc.run)} tiene el dígito verificador malo. ` +
                'Se registró igual: revíselo contra el documento.');
  }
  if (doc.documento_vence && doc.documento_vence < fechaChile()) {
    avisos.push(`El documento está vencido (venció el ${doc.documento_vence}).`);
  }

  const tipoVehiculo = texto(cuerpo.vehiculo_tipo, LARGOS.vehiculo_tipo);
  if (tipoVehiculo && !TIPOS_VEHICULO.includes(tipoVehiculo.toLowerCase())) {
    // No se rechaza: se guarda lo que escribió. La lista es una ayuda para
    // que lo normal se escriba siempre igual, no un molde al que la realidad
    // tenga que caber.
    avisos.push(`«${tipoVehiculo}» no está en la lista de tipos de vehículo. Se guardó así.`);
  }
  if (tipoVehiculo && !patente) {
    avisos.push('Se anotó un vehículo sin patente.');
  }

  let acompanantes = Number(cuerpo.acompanantes);
  if (!Number.isInteger(acompanantes) || acompanantes < 0) acompanantes = 0;
  if (acompanantes > 99) acompanantes = 99;

  const ahora = new Date();
  const [fila] = await insertar(env, 'accesos', {
    instalacion_id: instalacionId,
    run: doc.run,
    nombre,
    empresa: texto(cuerpo.empresa, LARGOS.empresa),
    origen_run: doc.origen_run,
    documento_tipo: doc.documento_tipo,
    documento_serie: doc.documento_serie,
    documento_vence: doc.documento_vence,
    motivo: texto(cuerpo.motivo, LARGOS.motivo),
    a_quien_visita: texto(cuerpo.a_quien_visita, LARGOS.a_quien_visita),
    patente,
    vehiculo_tipo: tipoVehiculo,
    vehiculo_detalle: texto(cuerpo.vehiculo_detalle, LARGOS.vehiculo_detalle),
    acompanantes,
    entrada_en: ahora.toISOString(),
    fecha: fechaChile(ahora),
    registrado_por: quien.usuario,
    registrado_por_nombre: quien.nombre,
    lat: numeroONulo(cuerpo.lat, -90, 90),
    lon: numeroONulo(cuerpo.lon, -180, 180),
    nota: texto(cuerpo.nota, LARGOS.nota),
  });

  await anotar(env, quien.usuario, 'acceso', fila.id, 'registró un ingreso',
    `${instalacion.nombre} · ${nombre || formatearRut(doc.run) || patenteLinda(patente)}`);

  return { acceso: { ...fila, instalacion: instalacion.nombre }, avisos };
}

function numeroONulo(v, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) return null;
  return n;
}

/**
 * Marca la salida.
 *
 * Es lo único que se escribe sobre una fila ya creada, y se escribe una sola
 * vez: una salida puesta no se corrige, igual que una marca del libro de
 * asistencia. Si quedó mal, se anota una novedad explicándolo, que es el
 * mismo camino que usa la oficina para todo lo demás.
 */
export async function marcarSalida(env, id, quien) {
  const acceso = await primero(env, `accesos?select=*&id=eq.${Number(id)}`);
  if (!acceso) return { error: 'Ese ingreso no existe', status: 404 };
  if (acceso.salida_en) {
    return {
      error: 'Ese ingreso ya tiene salida marcada. Una salida no se corrige: ' +
             'anote una novedad explicando lo que pasó.',
      status: 409,
    };
  }

  const [fila] = await actualizar(env, `accesos?id=eq.${acceso.id}`, {
    salida_en: new Date().toISOString(),
    salida_por: quien.usuario,
    salida_por_nombre: quien.nombre,
  });

  await anotar(env, quien.usuario, 'acceso', acceso.id, 'marcó una salida',
    acceso.nombre || formatearRut(acceso.run) || patenteLinda(acceso.patente) || null);

  return { acceso: fila };
}

/**
 * El listado.
 *
 * `adentro=1` devuelve solo los que no han salido, que es la pantalla que el
 * guardia mira todo el turno. Sin fecha se muestra el día de hoy: un listado
 * que arranca mostrando el año entero tarda y además no es lo que nadie busca.
 */
export async function listar(env, p) {
  const filtros = [];

  const inst = Number(p.get('instalacion'));
  if (Number.isInteger(inst) && inst > 0) filtros.push(`instalacion_id=eq.${inst}`);

  const soloAdentro = p.get('adentro') === '1';
  if (soloAdentro) {
    filtros.push('salida_en=is.null');
  } else {
    const desde = esFecha(p.get('desde')) ? p.get('desde') : fechaChile();
    const hasta = esFecha(p.get('hasta')) ? p.get('hasta') : desde;
    filtros.push(`fecha=gte.${desde}`, `fecha=lte.${hasta}`);
  }

  const patente = normalizarPatente(p.get('patente'));
  if (patente) filtros.push(`patente=eq.${patente}`);

  const run = normalizarRut(p.get('run'));
  if (run) filtros.push(`run=eq.${run}`);

  // Solo los que traen vehículo: es el «registro de ingreso de vehículos»,
  // que no es otra tabla sino este mismo listado mirado por ese lado.
  if (p.get('vehiculos') === '1') filtros.push('patente=not.is.null');

  const tope = Math.min(Math.max(Number(p.get('tope')) || 300, 1), 1000);
  const filas = await buscar(env,
    `v_accesos?select=*&${filtros.join('&')}&order=entrada_en.desc&limit=${tope}`);

  return {
    accesos: filas,
    adentro: filas.filter((f) => f.adentro).length,
    con_vehiculo: filas.filter((f) => f.patente).length,
    tope_alcanzado: filas.length >= tope,
  };
}

/**
 * Borra de los accesos viejos lo que identifica a una persona.
 *
 * Lo llama el disparador diario del Worker y también la oficina a mano desde
 * la pantalla. Es la misma función de la base, que se puede correr las veces
 * que sea porque solo toca lo que todavía no tocó.
 *
 * Va por PostgREST y no por la función `anonimizar_accesos` de la base para no
 * depender de que el esquema esté expuesto como RPC, que es configuración del
 * proyecto y no del repositorio. La función SQL queda igual, para poder
 * correrla desde el editor de Supabase sin el Worker en el medio.
 */
export async function anonimizarViejos(env, dias = DIAS_RETENCION) {
  const corte = new Date(Date.now() - dias * 86400000).toISOString();
  const filas = await actualizar(env,
    `accesos?anonimizado_en=is.null&entrada_en=lt.${corte}`,
    {
      run: null, nombre: null, a_quien_visita: null, patente: null,
      documento_serie: null, documento_vence: null, nota: null,
      anonimizado_en: new Date().toISOString(),
    });
  return Array.isArray(filas) ? filas.length : 0;
}

/** Cuántos accesos están esperando que se les borren los datos. */
export async function pendientesDeAnonimizar(env, dias = DIAS_RETENCION) {
  const corte = new Date(Date.now() - dias * 86400000).toISOString();
  const filas = await buscar(env,
    `accesos?select=id&anonimizado_en=is.null&entrada_en=lt.${corte}&limit=1000`);
  return Array.isArray(filas) ? filas.length : 0;
}
