# Control de acceso en terreno — Seguridad Garridos

La pantalla que el guardia usa en la caseta del puesto. Cuatro cosas que hoy
son papel:

1. **Accesos** — quién y qué entra y sale de la instalación, leyendo el código
   de la cédula con la cámara o escribiendo el RUN a mano. El registro de
   vehículos es este mismo listado visto por el lado de los que traen patente.
2. **Novedades** — el libro de novedades del turno.
3. **Turno** — el certificado de cambio de turno, firmado con el dedo por el
   que se retira y por el que ingresa.
4. **Eventos** — el informe de evento especial (una denuncia, un robo, un
   daño), firmado con el dedo.

Es un Worker aparte del de administración, con **la misma base de datos y las
mismas cuentas**: los guardias entran con la cuenta con que marcan turno
(tabla `trabajadores`) y la oficina con la suya (tabla `usuarios`). No se creó
un tercer registro de personas.

- En línea: `acceso.seggarridos.com` (ver `COMO-PUBLICAR.md`)
- Repositorio: `globseg-acceso`
- Base: Supabase `hjoljdjjsobweqbvlijr`, la misma del panel y del libro de
  asistencia.

---

## Lo que hay que saber antes de tocar esto

### La migración no se aplica sola
Desde el 14-10-2026 las migraciones de Supabase **no corren solas** en este
proyecto: hay que pegarlas a mano en el SQL Editor. Por eso todo lo que depende
de las tablas nuevas **degrada y nombra el archivo que falta** en vez de
reventar (`tablasListas()` en `src/index.js`).

Después de cada push que traiga migración, mirar
`https://acceso.seggarridos.com/api/diagnostico`: responde sí/no por tabla sin
mostrar ningún valor.

### Un ingreso por dominio
La cookie de sesión **no lleva atributo `Domain`**, igual que en el resto del
sistema. Quien use el panel y además esta aplicación entra dos veces. Es a
propósito: ponerle `Domain=seggarridos.com` la mandaría también a la página
pública, que es otro despliegue.

### `single-page-application`: una ruta mal escrita da 200, no 404
`wrangler.jsonc` usa `not_found_handling: "single-page-application"`, así que
un archivo que no existe **no da 404: da `index.html` con HTTP 200**. Al
agregar cualquier archivo nuevo a `public/`, verificar con el `content-type` y
no con el código:

```bash
curl -sI https://acceso.seggarridos.com/jsqr.js | grep -i content-type
```

### Un solo `<script>` en la página
`public/index.html` tiene todo su JavaScript en un `<script>` clásico, igual
que las otras páginas del sistema. Los `<script>` clásicos comparten el ámbito
global, así que un nombre repetido entre ese bloque y `apariencia.js`,
`firma.js` o `jsqr.js` da `SyntaxError: Identifier has already been declared` y
deja la página **en blanco**, no a medias.

Nombres ya ocupados: `ESCALAS`, `recordar`, `recordado`, `marcarSegmento`,
`aplicarTema`, `aplicarEscala`, `conectarApariencia`, `Firma`, `jsQR`.

### Archivos copiados del otro repositorio
`src/datos.js`, `src/rut.js`, `src/sesion.js` y `src/seguridad.js` son **copias**
de `ADMINISTRACION/src/`. Llevan una cabecera que lo dice, y lo que difiere a
propósito está marcado con «DIFERENCIA». Si uno de esos archivos cambia allá,
hay que traer el cambio acá a mano. Lo mismo con `public/apariencia.css`,
`public/apariencia.js` y `public/firma.js`.

Es el costo de que esto sea un Worker aparte, que fue una decisión del gerente.

---

## El código de la cédula chilena

Las cédulas emitidas desde 2013 traen un QR con una dirección del Registro
Civil que lleva escritos el RUN, el tipo de documento, el número de serie y una
franja `mrz` con la fecha de nacimiento y **la de vencimiento**:

```
https://portal.sidiv.registrocivil.cl/docstatus
  ?RUN=1916473-K&type=CEDULA&serial=516339654&mrz=516339654460121882312189
```

- **Esa dirección no se visita.** Se lee lo que trae escrito y nada más.
  Visitarla metería al Registro Civil en el camino de cada ingreso a una
  portería, y un parque sin señal dejaría de poder registrar visitas por una
  página ajena que no contesta.
- **El vencimiento es lo que hace que valga la pena leerlo**: deja ver en el
  momento que el carnet está vencido, que a ojo no se nota.
- Las cédulas viejas (2002) traen un PDF417 en el reverso, que es otro formato
  y muy difícil de leer con la cámara de un teléfono. Para ésas **se escribe el
  RUN a mano**, que es un camino que siempre tiene que estar abierto.
- El lector del servidor es `src/cedula.js` y **es el que manda**. La página
  tiene su propia lectura (`leerCedulaEnPantalla` en `index.html`) solo para
  mostrar el dato al tiro sin salir a la red; cuando se registra el ingreso se
  manda el texto crudo y el servidor lo vuelve a leer con la suya, porque entre
  la cámara y el servidor hay una página web y una página web se puede cambiar
  desde la consola del teléfono.
- El QR se lee con `BarcodeDetector` donde exista (Android con Chrome al día) y
  con `jsqr.js` donde no (Safari de iPhone). **jsqr.js está servido desde este
  mismo dominio y solo se baja cuando hace falta**, para poder dejar la
  política de contenido sin ningún origen de fuera.

---

## Las reglas que el sistema se niega a saltarse

- **Nada se edita ni se borra.** Una salida marcada no se corrige; una novedad
  mal escrita se corrige escribiendo otra que apunta a ella; un certificado o
  un informe equivocados se anulan con motivo y se hace otro.
- **Antes que perder el registro, se registra con un aviso.** Un repartidor sin
  cédula, un RUN con el dígito verificador malo, un documento vencido: todo eso
  se registra igual y la pantalla lo dice en ámbar. El ingreso ya ocurrió, y
  negarse a escribirlo solo haría que el guardia lo anote en un papel.
- **Una firma no se repite ni se corrige.** Si estaba mal, se anula el
  documento y se hace otro: dejar reescribir una firma sería dejar reescribir
  la prueba.
- **El texto se congela al crear el acta, no al imprimirla.** Si mañana se
  corrige el formato, lo ya firmado sigue diciendo lo que la persona leyó.
- **Un guardia no anula.** Anular es de gerencia y operaciones.
- **Los datos del visitante caducan al año.** Ver abajo.

## Qué se guarda de cada visitante, y por cuánto tiempo

Al año, `anonimizar_accesos()` le borra a cada acceso el **RUN, el nombre, a
quién venía a ver, la patente, el número de serie de la cédula y la nota
libre**, y deja el hecho: qué día, a qué hora, a qué instalación, con qué tipo
de vehículo y cuántos acompañantes. Así el registro sigue sirviendo para contar
y deja de ser una lista de personas.

La patente se borra porque lleva a una persona por el Registro Civil, y la nota
libre porque es donde el guardia escribe cualquier cosa, incluido un nombre.

**No se toca** lo que escriben los trabajadores: novedades, certificados e
informes de evento. Eso no son datos de visitantes, es el trabajo escrito de la
empresa; un informe de evento es además un documento firmado que puede terminar
en un tribunal, y vaciarlo a los doce meses sería destruir la prueba que se
construyó.

Corre solo todas las noches (el disparador de `wrangler.jsonc`), y la oficina
puede correrlo a mano desde Ajustes. Si el disparador dejara de correr,
`/api/diagnostico` muestra `accesos_esperando_anonimizacion` y ese número deja
de bajar: la falla se ve en vez de quedarse callada.

El plazo es `DIAS_RETENCION` en `src/acceso.js`. Cambiarlo es una línea.

---

## Qué clase de firma es, dicho sin adornos

Es **firma electrónica simple de la Ley 19.799**. Vale, y entre las partes hace
plena prueba mientras ninguna la objete; lo que se discute cuando alguien la
objeta es si se puede demostrar quién firmó y cuándo. **No es firma electrónica
avanzada**: eso exige un certificado de un prestador acreditado que la empresa
no tiene. El acta lo dice impreso al pie.

Cada firma guarda la hora **del servidor** (la del teléfono la cambia cualquiera
en Ajustes), la cuenta desde la que se firmó, el nombre y el RUT **congelados**,
el SHA-256 del texto firmado, una huella de la IP salada con `SESION_SECRETO` y
el navegador.

**Un detalle que la pantalla dice y conviene tener claro:** en un cambio de
turno los dos guardias firman en el mismo teléfono, así que la cuenta con la
sesión abierta es una sola. El sistema guarda el nombre que el acta le pone a
ese rol y, aparte, la cuenta desde la que se firmó. Lo que esta firma prueba es
que alguien firmó ese texto, a esa hora, desde esa cuenta — no que el sistema
haya verificado la identidad de quien dibujó el trazo.

Para poder firmar hay que haber cambiado la contraseña inicial: el servidor no
deja entrar a nadie que siga con el RUT de clave, y le dice adónde ir a
cambiarla.

---

## Cómo probarlo localmente (réplica de Supabase, sin tocar la nube)

Requiere `postgresql@16` y `postgrest` (los instala `brew`).

1. **Postgres sin socket unix.** La ruta del directorio temporal es más larga
   que los 103 bytes que admite un socket de Postgres, así que hay que
   levantarlo solo por TCP, y con `LC_ALL=C` o falla en macOS con «became
   multithreaded»:

   ```bash
   export LC_ALL=C
   initdb -D "$PG" -U postgres --auth=trust
   pg_ctl -D "$PG" -o "-p 5433 -c unix_socket_directories= -c listen_addresses=127.0.0.1" start
   createdb -h 127.0.0.1 -p 5433 -U postgres globseg
   psql -h 127.0.0.1 -p 5433 -U postgres -d globseg \
     -c "create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;"
   ```

2. **Las migraciones**, primero las 23 de `globseg-adm` y después la de acá:

   ```bash
   for f in ../ADMINISTRACION/supabase/migrations/*.sql supabase/migrations/*.sql; do
     psql -h 127.0.0.1 -p 5433 -U postgres -d globseg -v ON_ERROR_STOP=1 -f "$f"
   done
   ```

3. **PostgREST** con un `jwt-secret`, y un JWT de rol `service_role` firmado con
   ese mismo secreto, que va en `.dev.vars` como `SUPABASE_SERVICE_KEY`.
   `SUPABASE_REST` apunta a PostgREST.

   **Si se cambia el esquema, hay que reiniciar PostgREST**, no basta un
   `kill -HUP`: se queda con el caché viejo y todas las tablas empiezan a dar
   404, que parece un error del código y no lo es.

4. `npx wrangler dev --local --port 8799`

El archivo de pruebas de punta a punta está en el historial de esta sesión; son
67 comprobaciones sobre las reglas de arriba.

---

## Archivos

```
src/
  index.js      el enrutador, la sesión, los permisos y /api/diagnostico
  acceso.js     accesos de personas y vehículos, y la retención de datos
  novedades.js  el libro de novedades
  actas.js      certificado de cambio de turno, informe de evento y las firmas
  cedula.js     el lector del código de la cédula chilena
  fechas.js     la hora de Chile
  datos.js      · copia de ADMINISTRACION
  rut.js        · copia de ADMINISTRACION
  sesion.js     · copia de ADMINISTRACION, con tres DIFERENCIAS marcadas
  seguridad.js  · copia de ADMINISTRACION, con la cámara abierta
public/
  index.html    la única página: ingreso, las cuatro vistas, el escáner y la firma
  acceso.css    la apariencia propia
  apariencia.*  · copia de ADMINISTRACION (los tokens y el tema)
  firma.js      · copia de ADMINISTRACION (el lienzo de firma)
  jsqr.js       jsQR 1.4.0, Apache 2.0, servido desde acá
supabase/migrations/
  20261023120000_control_acceso.sql
PEGAR-EN-SUPABASE.sql   el mismo archivo con dos líneas en blanco de resguardo
COMO-PUBLICAR.md        los pasos que hay que hacer en los paneles
```
