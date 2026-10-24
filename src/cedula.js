/**
 * El código de la cédula de identidad chilena.
 *
 * Lo que trae la cédula, comprobado contra cédulas reales y no deducido:
 *
 *   https://portal.sidiv.registrocivil.cl/docstatus
 *     ?RUN=1916473-K
 *     &type=CEDULA
 *     &serial=516339654
 *     &mrz=516339654460121882312189
 *
 * Es una dirección web del Registro Civil que sirve para verificar en línea si
 * el documento está vigente. Acá **no se visita**: se lee lo que trae escrito y
 * nada más. Visitarla desde el Worker metería al Registro Civil en el camino
 * de cada ingreso a una portería, y un parque sin señal dejaría de poder
 * registrar visitas por una página ajena que no contesta.
 *
 * El `mrz` es la franja de lectura automática del documento, pegada sin
 * separadores. Su forma es:
 *
 *     <serie><dv> <nacimiento AAMMDD><dv> <vencimiento AAMMDD><dv>
 *
 * De ahí salen dos datos que el RUN solo no da: la fecha de nacimiento y, el
 * que de verdad sirve en una portería, **la fecha de vencimiento de la
 * cédula**, que deja ver en el momento que el carnet está vencido.
 *
 * Qué NO lee esto:
 *  - El PDF417 del reverso de las cédulas viejas (2002). Es otro formato, es
 *    mucho más difícil de leer con la cámara de un teléfono de noche, y quien
 *    llega con una de ésas se registra escribiendo el RUN a mano, que es el
 *    camino que siempre tiene que estar abierto.
 *  - La cédula digital de la aplicación del Registro Civil, que arma su propio
 *    código y cambia.
 *
 * Esto corre en el servidor y es la versión que manda. La página lee el mismo
 * código para mostrarlo al tiro, pero lo que se guarda sale de acá: lo que
 * llega del navegador es un texto que alguien pudo escribir a mano.
 */

import { normalizarRut, dvCorrecto } from './rut.js';

const HOST = 'portal.sidiv.registrocivil.cl';

// Los nombres con que el Registro Civil rotula cada documento, y cómo se
// llaman en castellano para mostrarlos.
const TIPOS = {
  CEDULA: 'Cédula de identidad',
  CEDULA_EXT: 'Cédula de identidad para extranjeros',
  PASAPORTE: 'Pasaporte',
  PASAPORTE_PG: 'Pasaporte diplomático',
  PASAPORTE_OFICIAL: 'Pasaporte oficial',
};

export const nombreTipo = (t) => TIPOS[t] || t || 'Documento';

/**
 * Año de dos dígitos a año completo.
 *
 * Hay que decidirlo distinto según de qué fecha se trate, y por eso recibe
 * `futuro`:
 *
 *  - Una **fecha de nacimiento** siempre ya pasó. Si los dos dígitos dan un
 *    año que todavía no llega, es del siglo pasado: «60» en 2026 es 1960.
 *  - Un **vencimiento** puede estar adelante. Estos códigos existen solo en
 *    las cédulas emitidas desde 2013, así que ninguna vence en el siglo XX:
 *    «31» es 2031 y no 1931.
 *
 * La librería de referencia que se consultó usa la misma regla para las dos, y
 * por eso devuelve 1931 para una cédula que vence en 2031. Acá se separan a
 * propósito.
 */
function anioCompleto(dosDigitos, futuro) {
  const yy = Number(dosDigitos);
  if (!Number.isInteger(yy)) return null;
  if (futuro) return 2000 + yy;
  const actual = Number(String(new Date().getUTCFullYear()).slice(2));
  return yy > actual ? 1900 + yy : 2000 + yy;
}

/** `601218` -> `1960-12-18`, o null si no es una fecha que exista. */
function fechaMrz(seis, futuro) {
  if (!/^\d{6}$/.test(seis)) return null;
  const anio = anioCompleto(seis.slice(0, 2), futuro);
  const mes = seis.slice(2, 4);
  const dia = seis.slice(4, 6);
  if (anio === null) return null;
  const iso = `${anio}-${mes}-${dia}`;
  const d = new Date(iso + 'T12:00:00Z');
  // Una fecha inventada como 2026-02-31 se convierte sola en marzo: hay que
  // comprobar que vuelve igual, o se guardaría un día que no existe.
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== iso) return null;
  return iso;
}

/**
 * Lee el texto de un código de cédula.
 *
 * Devuelve `{ ok: true, run, dv_ok, tipo, tipo_nombre, serie, nacimiento,
 * vence, vencida }` o `{ ok: false, motivo }`.
 *
 * Nunca lanza: lo que entra es un texto que leyó una cámara, y una cámara lee
 * cualquier cosa. Un código que no se entiende tiene que terminar en «escriba
 * el RUN a mano», no en un error.
 */
export function leerCedula(texto) {
  const t = String(texto ?? '').trim();
  if (!t) return { ok: false, motivo: 'No se leyó ningún código' };

  let url;
  try {
    url = new URL(t);
  } catch {
    return { ok: false, motivo: 'El código leído no es el de una cédula chilena' };
  }
  if (url.hostname.toLowerCase() !== HOST) {
    return { ok: false, motivo: 'El código leído no es el de una cédula chilena' };
  }

  const p = url.searchParams;
  const run = normalizarRut(p.get('RUN'));
  if (!run) {
    return { ok: false, motivo: 'El código no trae un RUN que se pueda leer' };
  }

  const tipo = (p.get('type') || '').toUpperCase() || null;
  const serie = (p.get('serial') || '').trim() || null;
  const mrz = (p.get('mrz') || '').trim();

  let nacimiento = null;
  let vence = null;
  // La franja solo se puede partir si empieza con la serie, que es lo que
  // marca dónde termina el primer campo. Si no empieza así, el resto no se
  // adivina: se devuelve el RUN, que es lo que importa, y se deja lo demás en
  // blanco en vez de inventar dos fechas.
  if (serie && mrz.startsWith(serie)) {
    const resto = mrz.slice(serie.length);
    // resto = <dv de la serie><nacimiento 6><dv><vencimiento 6><dv>
    if (resto.length >= 14) {
      nacimiento = fechaMrz(resto.slice(1, 7), false);
      vence = fechaMrz(resto.slice(8, 14), true);
    }
  }

  const hoy = new Date().toISOString().slice(0, 10);
  return {
    ok: true,
    run,
    // El dígito verificador se revisa igual aunque venga del documento: un
    // código mal leído por la cámara —un 8 por un 3— pasa por acá antes de
    // escribirse en la base.
    dv_ok: dvCorrecto(run),
    tipo,
    tipo_nombre: nombreTipo(tipo),
    serie,
    nacimiento,
    vence,
    vencida: vence ? vence < hoy : null,
  };
}
