/* Lienzo para firmar con el dedo.
 *
 * Lo usan las dos páginas —el panel y el libro de asistencia—, así que vive
 * acá y no copiado en cada una, por lo mismo que apariencia.js: dos copias
 * terminan separándose y nadie se entera hasta que una de las dos falla.
 *
 * Cuelga de un solo nombre global, `Firma`, y se asigna con `window.Firma =`
 * en vez de declararse con `const`. En estas páginas todo vive en un `<script>`
 * clásico y comparten ámbito global: un `const` repetido entre este archivo y
 * el de la página da «Identifier has already been declared» y deja la página
 * **en blanco**, no a medias.
 *
 * Por qué Pointer Events y no eventos de mouse ni de touch: son los mismos
 * para el dedo, el lápiz y el mouse, y traen `setPointerCapture`, que es lo
 * que hace que el trazo siga saliendo cuando el dedo se sale del recuadro en
 * vez de cortarse ahí. Con eventos de mouse, firmar en un teléfono no funciona
 * salvo que el navegador los emule, que llega tarde y pierde los primeros
 * milímetros de cada trazo.
 */
window.Firma = (function () {
  "use strict";

  /** Conecta un <canvas> y devuelve con qué preguntarle y limpiarlo. */
  function conectar(lienzo, opciones) {
    const op = opciones || {};
    const ctx = lienzo.getContext("2d");
    let dibujando = false;
    let hayTrazo = false;
    // El rectángulo de lo dibujado, para recortar al exportar: una firma
    // chiquita en una esquina de un lienzo grande sale diminuta en el PDF.
    let caja = null;
    let ultimo = null;

    // El lienzo se dibuja a la resolución real de la pantalla y se muestra al
    // tamaño del CSS. Sin esto, en un teléfono el trazo sale pixelado, que en
    // una firma se ve como si estuviera mal escaneada.
    function medir() {
      const r = lienzo.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 3);
      if (!r.width || !r.height) return;
      const ancho = Math.round(r.width * dpr);
      const alto = Math.round(r.height * dpr);
      if (lienzo.width === ancho && lienzo.height === alto) return;
      // Cambiar el tamaño borra el contenido: se guarda y se vuelve a poner,
      // o girar el teléfono borraría una firma ya hecha.
      const antes = hayTrazo ? lienzo.toDataURL("image/png") : null;
      lienzo.width = ancho;
      lienzo.height = alto;
      ctx.scale(dpr, dpr);
      estilo();
      if (antes) {
        const img = new Image();
        img.onload = () => ctx.drawImage(img, 0, 0, r.width, r.height);
        img.src = antes;
      }
    }

    function estilo() {
      ctx.lineWidth = 2.2;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      // El color se lee del CSS para que el trazo se vea en claro y en oscuro.
      ctx.strokeStyle = getComputedStyle(lienzo).color || "#111";
    }

    const punto = (e) => {
      const r = lienzo.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };

    function anotarCaja(p) {
      if (!caja) caja = { x1: p.x, y1: p.y, x2: p.x, y2: p.y };
      else {
        caja.x1 = Math.min(caja.x1, p.x); caja.y1 = Math.min(caja.y1, p.y);
        caja.x2 = Math.max(caja.x2, p.x); caja.y2 = Math.max(caja.y2, p.y);
      }
    }

    function empezar(e) {
      // Solo el trazo principal: un segundo dedo apoyado en la pantalla no
      // tiene que dibujar una raya por su cuenta.
      if (dibujando) return;
      dibujando = true;
      medir();
      try { lienzo.setPointerCapture(e.pointerId); } catch (_) { /* da igual */ }
      const p = punto(e);
      ultimo = p;
      anotarCaja(p);
      // Un punto suelto también es trazo: hay firmas que son un solo toque.
      ctx.beginPath();
      ctx.arc(p.x, p.y, 1.1, 0, Math.PI * 2);
      ctx.fillStyle = ctx.strokeStyle;
      ctx.fill();
      marcar();
      e.preventDefault();
    }

    function seguir(e) {
      if (!dibujando) return;
      // Los puntos que el sistema juntó entre dos cuadros. Usarlos es lo que
      // hace que un trazo rápido salga curvo y no como una línea quebrada.
      const puntos = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
      ctx.beginPath();
      ctx.moveTo(ultimo.x, ultimo.y);
      for (const ev of puntos) {
        const p = punto(ev);
        ctx.lineTo(p.x, p.y);
        anotarCaja(p);
        ultimo = p;
      }
      ctx.stroke();
      marcar();
      e.preventDefault();
    }

    function terminar(e) {
      if (!dibujando) return;
      dibujando = false;
      ultimo = null;
      try { lienzo.releasePointerCapture(e.pointerId); } catch (_) { /* da igual */ }
      e.preventDefault();
    }

    function marcar() {
      if (hayTrazo) return;
      hayTrazo = true;
      if (op.alCambiar) op.alCambiar(true);
    }

    lienzo.addEventListener("pointerdown", empezar);
    lienzo.addEventListener("pointermove", seguir);
    lienzo.addEventListener("pointerup", terminar);
    lienzo.addEventListener("pointercancel", terminar);
    lienzo.addEventListener("pointerleave", terminar);
    // Sin esto el navegador se lleva el gesto para hacer scroll y el trazo se
    // corta al primer movimiento. El CSS pone `touch-action:none` igual; esto
    // cubre los navegadores donde esa propiedad llega tarde.
    lienzo.addEventListener("touchstart", (e) => e.preventDefault(), { passive: false });
    lienzo.addEventListener("touchmove", (e) => e.preventDefault(), { passive: false });
    window.addEventListener("resize", medir);
    medir();

    function limpiar() {
      ctx.clearRect(0, 0, lienzo.width, lienzo.height);
      hayTrazo = false;
      caja = null;
      ultimo = null;
      estilo();
      if (op.alCambiar) op.alCambiar(false);
    }

    /**
     * La firma en PNG, recortada a lo dibujado y en negro sobre transparente.
     *
     * Se vuelve a dibujar en negro en vez de copiar los píxeles tal cual
     * porque el trazo en pantalla toma el color del tema: una firma hecha en
     * modo oscuro sería blanca, y en el PDF —que es blanco— no se vería.
     */
    function png() {
      if (!hayTrazo || !caja) return null;
      const margen = 8;
      const r = lienzo.getBoundingClientRect();
      const dpr = lienzo.width / (r.width || 1);
      const x = Math.max(0, caja.x1 - margen);
      const y = Math.max(0, caja.y1 - margen);
      const w = Math.min(r.width - x, caja.x2 - caja.x1 + margen * 2);
      const h = Math.min(r.height - y, caja.y2 - caja.y1 + margen * 2);

      // Tope de ancho. A la resolución del teléfono el recorte sale de más de
      // 1800 px, y en el PDF ocupa 44 mm: el visor igual la dibuja a ese
      // tamaño, pero el mapa de bits sin comprimir se lleva un mega. A 600 px
      // se ve nítida en el papel y el PDF queda en kilobytes.
      const MAX_ANCHO = 600;
      const recorteW = Math.max(1, Math.round(w * dpr));
      const recorteH = Math.max(1, Math.round(h * dpr));
      const escala = Math.min(1, MAX_ANCHO / recorteW);

      const salida = document.createElement("canvas");
      salida.width = Math.max(1, Math.round(recorteW * escala));
      salida.height = Math.max(1, Math.round(recorteH * escala));
      const sc = salida.getContext("2d");
      sc.drawImage(lienzo, Math.round(x * dpr), Math.round(y * dpr),
                   recorteW, recorteH, 0, 0, salida.width, salida.height);

      // Todo lo que tenga tinta pasa a negro; lo transparente se queda así.
      const datos = sc.getImageData(0, 0, salida.width, salida.height);
      const p = datos.data;
      for (let i = 0; i < p.length; i += 4) {
        if (p[i + 3] > 8) { p[i] = 0; p[i + 1] = 0; p[i + 2] = 0; }
      }
      sc.putImageData(datos, 0, 0);
      return salida.toDataURL("image/png");
    }

    return { limpiar, png, vacio: () => !hayTrazo, medir };
  }

  return { conectar };
})();
