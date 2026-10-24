# Cómo poner en línea el control de acceso

Son cinco pasos. Los tres primeros hay que hacerlos en una página web (GitHub,
Cloudflare, Supabase) porque piden la contraseña de esas cuentas. Después de
eso, cada cambio sale solo con un `git push`, igual que el panel.

Si algo no calza con lo que aparece en pantalla, pare y pregunte antes de
seguir: es más barato que deshacerlo.

---

## Paso 1 · Crear el repositorio en GitHub

En <https://github.com/new>, con la cuenta **contactoglobseg-ai**:

| Campo | Qué poner |
|---|---|
| Repository name | `globseg-acceso` |
| Description | Control de acceso en terreno — Seguridad Garridos |
| Visibilidad | **Private** |
| Add a README / .gitignore / license | **todo desmarcado** |

Apretar **Create repository**. Va a mostrar una página con instrucciones; no
hay que hacer nada ahí.

> Importante: el repositorio tiene que quedar **vacío**. Si se marca «Add a
> README», GitHub crea un commit propio y el primer `push` va a ser rechazado.

Cuando esté creado, avíseme y yo subo el código (la llave SSH de este
computador ya tiene acceso a esa cuenta).

---

## Paso 2 · Crear el Worker en Cloudflare

En el panel de Cloudflare, **Compute (Workers) → Crea una aplicación →
Continue with GitHub**. Es la misma pantalla con la que se publicó el panel.

1. Autorizar el repositorio `globseg-acceso`.
2. En la configuración del proyecto:

| Campo | Qué poner |
|---|---|
| Nombre del Worker | `globseg-acceso` |
| Build command | *(vacío)* |
| Deploy command | `npx wrangler deploy` |
| Root directory | `/` |

3. **Deploy**.

> La carpeta que se sirve (`./public`) está escrita en `wrangler.jsonc`, no en
> el formulario del panel. No hace falta ponerla ahí.

---

## Paso 3 · Los dos secretos del Worker

En **Workers & Pages → globseg-acceso → Settings → Variables and Secrets**,
agregar los dos **como Secret** (no como Text):

| Nombre | Valor |
|---|---|
| `SUPABASE_SERVICE_KEY` | La clave **secret** del proyecto de Supabase (empieza con `sb_secret_`) |
| `SESION_SECRETO` | **Exactamente el mismo** que ya tiene el Worker `globseg-adm` |

Tres cosas que importan:

- **La clave de Supabase hay que copiarla con el botón de copiar**, no
  seleccionando el texto que se ve en pantalla: lo que se ve está enmascarado
  con puntitos y esos puntitos se copian, y después el servidor responde
  «Invalid API key».
- Tiene que ser la **secret**, no la **publishable**. Si se equivoca, la
  aplicación va a decir que la clave no tiene permisos.
- **`SESION_SECRETO` tiene que ser el mismo del panel.** No es para compartir
  sesiones —cada dominio tiene la suya— sino porque con él se salan las huellas
  de IP que quedan en las firmas; con dos secretos distintos la misma conexión
  dejaría dos huellas distintas y no se podrían comparar entre sistemas.

`SUPABASE_URL` **no** se pone acá: ya está en `wrangler.jsonc`, y cada
despliegue borra las variables de texto que se hayan puesto a mano en el panel.

---

## Paso 4 · El dominio `acceso.seggarridos.com`

En **Workers & Pages → globseg-acceso → Settings → Domains & Routes → Add →
Custom domain**, escribir `acceso.seggarridos.com`.

El subdominio está libre: hoy no apunta a nada. Cloudflare crea el registro de
DNS y el certificado solo, y demora unos minutos.

> Si desde el computador de la oficina sigue sin abrir cuando ya debería,
> puede ser la caché de DNS del Mac. Se arregla con:
> ```bash
> sudo dscacheutil -flushcache; sudo killall -HUP mDNSResponder
> ```

---

## Paso 5 · Pegar la migración en Supabase

Esto es lo que crea las tablas. **Sin esto la aplicación se abre igual pero no
deja registrar nada**, y dice en pantalla cuál es el archivo que falta.

1. Copiar el archivo, en la Terminal:

   ```bash
   pbcopy < "/Users/macbookpro/Desktop/EMPRESAS/Seguridad Garridos/CONTROL-ACCESO/PEGAR-EN-SUPABASE.sql"
   ```

   Con `pbcopy` se copia exacto. Seleccionar el texto a mano desde el editor se
   come caracteres, y ya pasó una vez: se perdió un guion de la primera línea y
   el editor de Supabase contestó `syntax error at or near "-"`. Por eso el
   archivo empieza con **dos líneas en blanco de resguardo**: si el editor
   vuelve a comerse el primer carácter, se come un salto de línea y no SQL.

2. Ir a <https://supabase.com/dashboard/project/hjoljdjjsobweqbvlijr/sql/new>,
   pegar y apretar **Run**.

3. Tiene que terminar diciendo `control de acceso listo` y una fila con puros
   ceros. Los ceros están bien: las tablas están recién creadas y todavía no
   tienen nada adentro. Lo que importa es que no salga ningún error en rojo.

> Esta migración **se puede correr las veces que sea**. Si no está seguro de si
> la pegó, péguela de nuevo: no duplica nada.

---

## Paso 6 · Comprobar que quedó bien

Abrir <https://acceso.seggarridos.com/api/diagnostico>. Tiene que decir:

- `url_configurada: true`
- `clave_presente: true` y `clave_es_la_secreta_nueva: true`
- `secreto_de_sesion_configurado: true`
- en `tablas`, **todo en `true`**

Si alguna tabla sale en `false`, es que falta pegar la migración (paso 5).

Después, entrar a <https://acceso.seggarridos.com> con una cuenta de oficina y
registrar un ingreso de prueba en alguna instalación.

> **Antes de que el primer guardia pueda entrar** tiene que haber cambiado su
> contraseña inicial en `asistencia.seggarridos.com`, donde marca el turno. El
> que todavía tenga el RUT de clave no entra acá, y la pantalla le dice adónde
> ir. Es a propósito: lo que se escribe acá se firma y sirve de respaldo frente
> a un reclamo, y una cuenta cuya clave es el RUT —que lo sabe cualquiera que
> haya visto un contrato— no identifica a nadie.

---

## De ahí en adelante

Cada cambio al código sale solo: `commit` + `push` a `main`, y Cloudflare
publica en menos de un minuto.

**Lo único que no sale solo son las migraciones.** Cuando un cambio traiga una,
hay que repetir el paso 5 y después mirar `/api/diagnostico`.
