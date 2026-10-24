/* =============================================================================
 * COPIA de ADMINISTRACION/src/rut.js (repositorio globseg-adm), al 23-10-2026.
 *
 * Esta aplicación es un Worker aparte, así que no puede importar de allá. La
 * copia es a propósito y tiene un costo: si el archivo de allá cambia, hay que
 * traer el cambio acá a mano. Lo que difiere a propósito está marcado con
 * «DIFERENCIA» y explicado en el mismo lugar; todo lo demás es idéntico y
 * conviene que siga siéndolo.
 * ========================================================================== */

/**
 * RUT chileno.
 *
 * Vive aparte porque lo usan tres cosas distintas: el alta del trabajador, su
 * ingreso (el RUT es su contraseña) y la ficha que muestra la oficina. Si cada
 * una lo normalizara a su manera, un trabajador cargado con puntos no podría
 * entrar escribiéndolo sin puntos, y el error sería imposible de ver.
 *
 * Normalizar es siempre lo mismo: sin puntos, sin guión, sin espacios y con la
 * K en mayúscula. Así, escriba como escriba, se compara contra lo mismo.
 */

/** Deja el RUT en su forma canónica, o null si no tiene forma de RUT. */
export function normalizarRut(valor) {
  const t = String(valor ?? '').trim().toUpperCase().replace(/[.\-\s]/g, '');
  return /^[0-9]{6,9}[0-9K]$/.test(t) ? t : null;
}

/**
 * Verifica el dígito verificador (módulo 11).
 *
 * Se revisa al crear al trabajador, no al ingresar: un RUT mal tecleado en el
 * alta deja a esa persona sin poder entrar nunca, y nadie entendería por qué.
 * Mejor rechazarlo en el momento, frente a quien lo está escribiendo.
 */
export function dvCorrecto(rutNormalizado) {
  const rut = normalizarRut(rutNormalizado);
  if (!rut) return false;
  const cuerpo = rut.slice(0, -1);
  const dv = rut.slice(-1);
  let suma = 0;
  let factor = 2;
  for (let i = cuerpo.length - 1; i >= 0; i--) {
    suma += Number(cuerpo[i]) * factor;
    factor = factor === 7 ? 2 : factor + 1;
  }
  const resto = 11 - (suma % 11);
  const esperado = resto === 11 ? '0' : resto === 10 ? 'K' : String(resto);
  return dv === esperado;
}

/** 123456789 -> 12.345.678-9, para mostrarlo en la ficha. */
export function formatearRut(valor) {
  const rut = normalizarRut(valor);
  if (!rut) return String(valor ?? '');
  const cuerpo = rut.slice(0, -1);
  const dv = rut.slice(-1);
  return cuerpo.replace(/\B(?=(\d{3})+(?!\d))/g, '.') + '-' + dv;
}
