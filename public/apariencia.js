"use strict";
/**
 * Apariencia compartida por el panel y el libro de asistencia.
 * ---------------------------------------------------------------------------
 * Tema y tamaño de letra. Se guardan en el navegador de cada quien: Joaquín
 * puede trabajar en oscuro y Valeria en claro con letra grande, sin pisarse.
 *
 * Esto estaba escrito dos veces, una en cada página, y ya se había empezado a
 * separar solo: `conectarApariencia` escuchaba en el contenedor en una página
 * y botón por botón en la otra, y `marcarSegmento` difería en el formato
 * porque alguien reformateó una copia y no la otra. Hacían lo mismo hoy, pero
 * nadie decidió que fueran distintas.
 *
 * Va como archivo aparte y no inline porque las dos CSP ya permiten
 * `script-src 'self'` — incluida la del libro de asistencia, que a propósito
 * no deja cargar nada de fuera del dominio. Se carga ANTES del <script> propio
 * de cada página, que es quien llama a conectarApariencia().
 *
 * Lo que NO está acá, a propósito:
 *  - El script del <head> que aplica el tema antes del primer pintado. Sigue
 *    inline en las dos páginas: un archivo aparte se baja después y devuelve
 *    el destello blanco que ese script existe para evitar.
 *  - `pedir()`, que solo difiere en la ruta base ("/api" contra
 *    "/api/asistencia"). Unificarla obliga a arrastrar la base en cada
 *    llamada de las dos páginas: más ruido del que ahorra.
 *  - `$`, que cada página define para su propio uso.
 *
 * El guardado puede fallar —ventana privada, cookies bloqueadas— y eso no
 * puede romper la pantalla, así que cada acceso va protegido y el valor por
 * defecto siempre funciona.
 */

const ESCALAS = ["0.875", "1", "1.125", "1.25"];

const recordar = (clave, valor) => {
  try { localStorage.setItem("globseg." + clave, valor); } catch { /* da igual */ }
};
const recordado = (clave) => {
  try { return localStorage.getItem("globseg." + clave); } catch { return null; }
};

function marcarSegmento(selector, campo, valor) {
  const caja = document.querySelector(selector);
  if (!caja) return;
  caja.querySelectorAll("button").forEach(b => {
    b.setAttribute("aria-pressed", String(b.dataset[campo] === String(valor)));
  });
}

function aplicarTema(tema) {
  // "auto" se expresa quitando el atributo: así manda @prefers-color-scheme.
  if (tema === "claro" || tema === "oscuro") {
    document.documentElement.dataset.tema = tema;
  } else {
    delete document.documentElement.dataset.tema;
  }
  marcarSegmento("#seg-tema", "tema", tema);
}

function aplicarEscala(escala) {
  const e = ESCALAS.includes(String(escala)) ? String(escala) : "1";
  document.documentElement.style.setProperty("--escala", e);
  marcarSegmento("#seg-letra", "escala", e);
}

/**
 * Engancha los dos selectores del encabezado.
 *
 * Escucha en el contenedor y no botón por botón: así sigue andando si mañana
 * se agrega un cuarto tema o un quinto tamaño desde JavaScript, sin tener que
 * acordarse de volver a conectar. De las dos versiones que había, esta es la
 * que aguanta ese cambio.
 *
 * Si la página no trae los selectores no pasa nada: el tema y la escala
 * guardados se aplican igual, que es lo que importa.
 */
function conectarApariencia() {
  aplicarTema(recordado("tema") || "auto");
  aplicarEscala(recordado("escala") || "1");

  const segmento = (selector, campo, alElegir) => {
    const caja = document.querySelector(selector);
    if (!caja) return;
    caja.onclick = ev => {
      const b = ev.target.closest("button");
      if (!b || !caja.contains(b)) return;
      recordar(campo, b.dataset[campo]);
      alElegir(b.dataset[campo]);
    };
  };

  segmento("#seg-tema", "tema", aplicarTema);
  segmento("#seg-letra", "escala", aplicarEscala);
}
