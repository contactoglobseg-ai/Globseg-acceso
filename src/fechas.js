/**
 * La hora de Chile.
 *
 * Mismo criterio y mismo código que `fechaChile`/`horaChile` en
 * ADMINISTRACION/src/asistencia.js: el día al que pertenece lo que se registra
 * se cuenta en hora de Chile y no en UTC. Sin esto, todo lo que entra a la
 * instalación después de las 21:00 aparecería al día siguiente en el listado,
 * y el turno de noche —que es cuando más se usa esta pantalla— quedaría
 * partido en dos días que no existen.
 *
 * Vive en un archivo propio y chico porque lo usan los cuatro módulos.
 */

const ZONA = 'America/Santiago';

function conZona(opciones) {
  try {
    return new Intl.DateTimeFormat('es-CL', { timeZone: ZONA, ...opciones });
  } catch {
    // Si la plataforma no conociera la zona, se cae al huso de Chile
    // continental en horario de verano. Es un respaldo para no quedarse sin
    // responder, no la regla.
    return null;
  }
}

// Reciben lo que venga: un Date, o el texto que devuelve la base. Darle el
// texto directo a Intl revienta con «Invalid time value».
const comoFecha = (d) => (d instanceof Date ? d : new Date(d));

/** El día en Chile, como `2026-10-23`. */
export function fechaChile(valor = new Date()) {
  const d = comoFecha(valor);
  // en-CA da directamente AAAA-MM-DD, que es lo que espera la columna `date`.
  const f = conZona({ year: 'numeric', month: '2-digit', day: '2-digit' });
  if (f) {
    const p = Object.fromEntries(f.formatToParts(d).map((x) => [x.type, x.value]));
    return `${p.year}-${p.month}-${p.day}`;
  }
  return new Date(d.getTime() - 3 * 3600000).toISOString().slice(0, 10);
}

/** La hora en Chile, como `21:05`. */
export function horaChile(valor = new Date()) {
  const d = comoFecha(valor);
  const f = conZona({ hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  if (f) {
    const p = Object.fromEntries(f.formatToParts(d).map((x) => [x.type, x.value]));
    return `${p.hour}:${p.minute}`;
  }
  return new Date(d.getTime() - 3 * 3600000).toISOString().slice(11, 16);
}

/** `23 de octubre de 2026`, para el cuerpo de un certificado. */
export function fechaLarga(valor = new Date()) {
  const [a, m, d] = fechaChile(valor).split('-');
  const meses = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio',
                 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
  return `${Number(d)} de ${meses[Number(m) - 1]} de ${a}`;
}

/** `2026-10-23` -> `23-10-2026`, para mostrar. No valida: solo da vuelta. */
export const fechaCorta = (iso) =>
  (typeof iso === 'string' && /^\d{4}-\d{2}-\d{2}/.test(iso))
    ? `${iso.slice(8, 10)}-${iso.slice(5, 7)}-${iso.slice(0, 4)}` : (iso || '');

/** Verdadero si el texto tiene forma de fecha AAAA-MM-DD y existe. */
export function esFecha(texto) {
  if (typeof texto !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(texto)) return false;
  const d = new Date(texto + 'T12:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === texto;
}
