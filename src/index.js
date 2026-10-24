/**
 * Control de acceso en terreno — acceso.seggarridos.com
 *
 * Worker propio, repositorio propio, subdominio propio, y la **misma base y
 * las mismas cuentas** que el resto del sistema. Entra el guardia con la
 * cuenta con que marca turno (tabla `trabajadores`) y entra la oficina con la
 * suya (tabla `usuarios`): acá no se crea un tercer registro de personas.
 *
 * Lo que vive en este Worker, y nada más:
 *   · accesos      — quién y qué entra y sale de una instalación
 *   · novedades    — el libro de novedades del puesto
 *   · certificados — el cambio de turno, firmado por los dos
 *   · eventos      — el informe de evento especial, firmado
 *
 * Dos cosas que conviene saber antes de tocar esto:
 *
 *  - **La cookie no lleva `Domain`**, igual que en el resto del sistema. Eso
 *    significa que quien use el panel y además esta aplicación entra dos
 *    veces. Es a propósito: ponerle `Domain=seggarridos.com` la mandaría
 *    también a la página pública, que es otro despliegue.
 *  - **La migración no se aplica sola.** Desde el 14-10-2026 hay que pegarla a
 *    mano en el SQL Editor de Supabase. Por eso todo lo que depende de las
 *    tablas nuevas degrada solo y nombra el archivo que falta, en vez de
 *    reventar: ver `tablasListas()`.
 */

import { ErrorDatos, buscar, primero, anotar } from './datos.js';
import { redireccionHttps, cabecerasSeguridad, conCabeceras, soloHttps } from './seguridad.js';
import { ingresar, crearSesion, leerSesion, cookieSesion, cookieBorrada,
         duracionSesion } from './sesion.js';
import { normalizarRut } from './rut.js';
import { leerCedula } from './cedula.js';
import { fechaChile } from './fechas.js';
import * as acc from './acceso.js';
import * as nov from './novedades.js';
import * as actas from './actas.js';

const MIGRACION = 'supabase/migrations/20261023120000_control_acceso.sql';

const json = (datos, status = 200, extra = {}) =>
  new Response(JSON.stringify(datos), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...soloHttps(),
      ...extra,
    },
  });

const error = (mensaje, status = 400, extra = {}) => json({ error: mensaje }, status, extra);

// ------------------------------------------------------- ¿está la migración?
/**
 * Si las tablas de esta aplicación existen.
 *
 * Se recuerda el sí y no el no: una tabla que existe no desaparece, pero una
 * que falta aparece en cuanto el gerente pega la migración, y no hay por qué
 * obligarlo a esperar a que Cloudflare recicle el isolate para que el sistema
 * se entere.
 */
let tablasOk = false;
async function tablasListas(env) {
  if (tablasOk) return true;
  try {
    await buscar(env, 'accesos?select=id&limit=1');
    await buscar(env, 'firmas_acceso?select=id&limit=1');
    tablasOk = true;
    return true;
  } catch {
    return false;
  }
}

const faltaMigracion = () => error(
  'Falta aplicar la migración de esta aplicación en Supabase: ' + MIGRACION +
  '. Hasta entonces no se puede registrar nada acá; el libro de asistencia y ' +
  'el panel siguen funcionando igual.', 503);

// --------------------------------------------------------------- quién entra
/**
 * Qué puede hacer cada quien.
 *
 * El guardia registra y firma; no anula ni borra datos. Anular un informe de
 * evento es una decisión de la empresa, no de quien lo escribió: si el guardia
 * pudiera anular el suyo, el informe dejaría de ser una constancia y pasaría a
 * ser un borrador.
 *
 * La oficina entera lee y escribe —son cuatro personas que se cubren entre
 * ellas—, y anular queda en gerencia y operaciones, que son las dos áreas que
 * responden por lo que pasa en terreno.
 */
const PUEDE_ANULAR = ['gerencia', 'operaciones'];

async function identificar(request, env) {
  const guardia = await leerSesion(request, env, 'acceso');
  if (guardia) {
    const t = await primero(env,
      `trabajadores?select=id,usuario,nombre,rut,cargo,activo,instalacion_id,debe_cambiar_clave` +
      `&usuario=eq.${encodeURIComponent(guardia)}`);
    if (!t || !t.activo) return null;
    return {
      tipo: 'guardia',
      usuario: t.usuario,
      nombre: t.nombre,
      rut: t.rut,
      cargo: t.cargo,
      trabajador_id: t.id,
      instalacion_id: t.instalacion_id,
      debe_cambiar_clave: t.debe_cambiar_clave,
      puede_anular: false,
    };
  }

  const oficina = await leerSesion(request, env, 'acceso_oficina');
  if (oficina) {
    const u = await primero(env,
      `usuarios?select=usuario,nombre,rol,activo,debe_cambiar_clave` +
      `&usuario=eq.${encodeURIComponent(oficina)}`);
    if (!u || !u.activo) return null;
    return {
      tipo: 'oficina',
      usuario: u.usuario,
      nombre: u.nombre,
      rut: null,
      cargo: u.rol,
      trabajador_id: null,
      instalacion_id: null,
      debe_cambiar_clave: u.debe_cambiar_clave,
      puede_anular: PUEDE_ANULAR.includes(u.rol),
    };
  }
  return null;
}

/**
 * Entrar.
 *
 * Un solo formulario para los dos tipos de cuenta. Los nombres de usuario son
 * únicos entre las dos tablas —el que los arma le agrega un número si choca,
 * incluso contra una cuenta de oficina—, así que se mira primero dónde está
 * esa cuenta y después se verifica contra esa tabla sola. Probar en las dos
 * costaría dos derivaciones PBKDF2 por intento y además haría que el tiempo de
 * respuesta delatara en cuál de las dos está cada usuario.
 *
 * La clave del guardia es la misma con que entra al libro de asistencia, y se
 * normaliza igual: da lo mismo si escribe el RUT con puntos o sin ellos.
 */
async function entrar(request, env, url) {
  const datos = await request.json().catch(() => ({}));
  const u = String(datos.usuario ?? '').trim().toLowerCase();

  // El mismo texto para los dos casos: si dijera uno para los guardias y otro
  // para la oficina, bastaría leer cuál sale para saber en qué tabla está una
  // cuenta.
  const GENERICO = 'Usuario o contraseña incorrectos';

  let esGuardia = false;
  if (u) {
    const t = await primero(env,
      `trabajadores?select=id&usuario=eq.${encodeURIComponent(u)}`).catch(() => null);
    esGuardia = !!t;
  }

  const r = await ingresar(env, datos.usuario, datos.clave, esGuardia
    ? {
        tabla: 'trabajadores',
        // Igual que en asistencia: el RUT se compara siempre contra la misma
        // forma, escriba el guardia como escriba.
        prepararClave: (c) => normalizarRut(c) || String(c ?? '').trim(),
        mensajeGenerico: GENERICO,
      }
    : { tabla: 'usuarios', mensajeGenerico: GENERICO });

  if (r.error) return error(r.error, r.status);

  // Mientras la cuenta siga con la clave inicial no se entra acá. Lo que se
  // escribe en esta aplicación se firma y se usa de respaldo frente a un
  // reclamo, y una cuenta cuya clave es el RUT —que lo sabe cualquiera que
  // haya visto un contrato— no identifica a nadie. El cambio se hace en un
  // solo lugar, no en tres, y acá se dice cuál.
  if (r.usuario.debe_cambiar_clave) {
    return error(
      esGuardia
        ? 'Antes de entrar acá tiene que elegir su propia contraseña. Hágalo en ' +
          'asistencia.seggarridos.com, donde marca su turno, y vuelva.'
        : 'Antes de entrar acá tiene que cambiar su contraseña en ' +
          'adm.seggarridos.com y volver.',
      403);
  }

  const ambito = esGuardia ? 'acceso' : 'acceso_oficina';
  const cookie = await crearSesion(r.usuario, env, ambito);
  const seguro = url.protocol === 'https:';
  await anotar(env, r.usuario.usuario, esGuardia ? 'trabajador' : 'usuario', null,
    'ingresó al control de acceso', null);

  return json({
    ok: true,
    usuario: {
      usuario: r.usuario.usuario,
      nombre: r.usuario.nombre,
      tipo: esGuardia ? 'guardia' : 'oficina',
    },
  }, 200, {
    'set-cookie': cookieSesion(cookie, duracionSesion(ambito), seguro, ambito),
  });
}

// ------------------------------------------------------------- diagnóstico
async function revisarTablas(env) {
  const r = {};
  for (const t of ['accesos', 'novedades', 'cambios_turno', 'eventos_especiales',
                   'firmas_acceso', 'v_accesos', 'v_novedades', 'v_cambios_turno',
                   'v_eventos']) {
    try {
      await buscar(env, `${t}?select=id&limit=1`);
      r[t] = true;
    } catch {
      r[t] = false;
    }
  }
  // Las tres del resto del sistema de las que esta aplicación depende. Si
  // alguna diera false, el problema no es de acá: es que se apuntó a otra base.
  for (const t of ['trabajadores', 'usuarios', 'instalaciones', 'datos_empresa']) {
    try {
      await buscar(env, `${t}?select=*&limit=1`);
      r[t] = true;
    } catch {
      r[t] = false;
    }
  }
  return r;
}

// ------------------------------------------------------------------- la API
async function api(request, env, url, quien) {
  const p = url.searchParams;
  const ruta = url.pathname.replace(/^\/api/, '');
  const metodo = request.method;
  const cuerpo = (metodo === 'POST' || metodo === 'PATCH')
    ? await request.json().catch(() => ({})) : {};

  // ---------------------------------------------------------------- quién soy
  if (ruta === '/yo' && metodo === 'GET') {
    const instalaciones = await buscar(env,
      'instalaciones?select=id,nombre,comuna,region&activa=is.true&order=nombre.asc')
      .catch(() => []);
    return json({
      usuario: {
        usuario: quien.usuario, nombre: quien.nombre, tipo: quien.tipo,
        cargo: quien.cargo, puede_anular: quien.puede_anular,
        instalacion_id: quien.instalacion_id,
      },
      instalaciones,
      categorias: nov.GLOSA_CATEGORIA,
      tipos_evento: actas.TIPOS_EVENTO,
      dias_retencion: acc.DIAS_RETENCION,
      hoy: fechaChile(),
    });
  }

  // ------------------------------------------------ leer un código de cédula
  //
  // La página ya lee el código por su cuenta para mostrarlo al tiro. Esta ruta
  // existe para el caso en que el navegador no sepa leer códigos y para que el
  // guardia pueda comprobar un documento sin registrar nada todavía. Lo que
  // manda, cuando se registra el ingreso, es lo que vuelve a leer el servidor.
  if (ruta === '/cedula' && metodo === 'POST') {
    return json(leerCedula(cuerpo.qr));
  }

  // ------------------------------------------------------------- los accesos
  if (ruta === '/accesos' && metodo === 'GET') {
    return json(await acc.listar(env, p));
  }
  if (ruta === '/accesos' && metodo === 'POST') {
    const r = await acc.registrarIngreso(env, cuerpo, quien);
    return r.error ? error(r.error, r.status) : json(r, 201);
  }
  let m = ruta.match(/^\/accesos\/(\d+)\/salida$/);
  if (m && metodo === 'POST') {
    const r = await acc.marcarSalida(env, m[1], quien);
    return r.error ? error(r.error, r.status) : json(r);
  }

  // ----------------------------------------------------------- las novedades
  if (ruta === '/novedades' && metodo === 'GET') {
    return json(await nov.listar(env, p));
  }
  if (ruta === '/novedades' && metodo === 'POST') {
    const r = await nov.escribir(env, cuerpo, quien);
    return r.error ? error(r.error, r.status) : json(r, 201);
  }

  // ------------------------------------------------- certificados y eventos
  for (const [prefijo, entidad] of [['/turnos', 'cambio_turno'], ['/eventos', 'evento']]) {
    if (ruta === prefijo && metodo === 'GET') {
      return json(await actas.listarActas(env, entidad, p));
    }
    if (ruta === prefijo && metodo === 'POST') {
      const r = entidad === 'cambio_turno'
        ? await actas.crearCertificado(env, cuerpo, quien)
        : await actas.crearEvento(env, cuerpo, quien);
      return r.error ? error(r.error, r.status) : json(r, 201);
    }
    m = ruta.match(new RegExp(`^${prefijo}/(\\d+)$`));
    if (m && metodo === 'GET') {
      const r = await actas.verActa(env, entidad, m[1]);
      return r.error ? error(r.error, r.status) : json(r);
    }
    m = ruta.match(new RegExp(`^${prefijo}/(\\d+)/firma$`));
    if (m && metodo === 'POST') {
      const r = await actas.firmar(env, entidad, m[1], cuerpo, quien, request);
      return r.error ? error(r.error, r.status) : json(r);
    }
    m = ruta.match(new RegExp(`^${prefijo}/(\\d+)/anular$`));
    if (m && metodo === 'POST') {
      if (!quien.puede_anular) {
        return error(
          'Anular un documento lo hace gerencia o operaciones. Si está mal, ' +
          'avise y que lo anulen desde el panel.', 403);
      }
      const r = await actas.anular(env, entidad, m[1], cuerpo.motivo, quien);
      return r.error ? error(r.error, r.status) : json(r);
    }
  }

  // ---------------------------------------- quién puede estar en un relevo
  if (ruta === '/trabajadores' && metodo === 'GET') {
    const inst = Number(p.get('instalacion'));
    const filtro = Number.isInteger(inst) && inst > 0
      ? `&instalacion_id=eq.${inst}` : '';
    const filas = await buscar(env,
      `trabajadores?select=id,nombre,rut,cargo,instalacion_id&activo=is.true${filtro}` +
      '&order=nombre.asc&limit=400');
    return json({ trabajadores: filas });
  }

  // --------------------------------------------------------- la retención
  if (ruta === '/mantenimiento/anonimizar' && metodo === 'POST') {
    if (quien.tipo !== 'oficina') {
      return error('Esto lo corre la oficina', 403);
    }
    const cuantos = await acc.anonimizarViejos(env);
    await anotar(env, quien.usuario, 'acceso', null, 'borró datos de visitantes vencidos',
      `${cuantos} registro${cuantos === 1 ? '' : 's'} de más de ${acc.DIAS_RETENCION} días`);
    return json({ ok: true, anonimizados: cuantos, dias: acc.DIAS_RETENCION });
  }

  return error('Ruta no encontrada', 404);
}

// ---------------------------------------------------------------- entrada
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Nada se contesta en claro. Tiene que ser lo primero: si la página de
    // ingreso llega a entregarse por http, la contraseña ya viaja a la vista.
    const aHttps = redireccionHttps(request, url);
    if (aHttps) return aHttps;

    // Una sola página. Cualquier ruta que pida una página entrega index.html,
    // y los archivos los sigue entregando el servidor de archivos.
    //
    // Ojo al agregar un archivo nuevo a `public/`: con
    // `not_found_handling: "single-page-application"`, una ruta mal escrita
    // **no da 404, da index.html con HTTP 200**. Se verifica con el
    // content-type, no con el código: `curl -sI <url> | grep content-type`.
    if (!url.pathname.startsWith('/api/')) {
      return conCabeceras(await env.ASSETS.fetch(request), cabecerasSeguridad());
    }

    try {
      if (url.pathname === '/api/diagnostico') {
        const k = (env.SUPABASE_SERVICE_KEY || '').trim();
        let pendientes = null;
        try { pendientes = await acc.pendientesDeAnonimizar(env); } catch { /* sin tablas */ }
        return json({
          aplicacion: 'control de acceso',
          migracion: MIGRACION,
          url_configurada: !!env.SUPABASE_URL,
          clave_presente: k.length > 0,
          clave_es_la_secreta_nueva: k.startsWith('sb_secret_'),
          clave_es_la_antigua_jwt: k.startsWith('ey') && k.split('.').length === 3,
          clave_es_la_publica: k.startsWith('sb_publishable_'),
          clave_tiene_caracteres_raros: /[^\x21-\x7E]/.test(k),
          clave_parece_recortada: k.length > 0 && k.length < 30,
          secreto_de_sesion_configurado: !!env.SESION_SECRETO,
          dias_retencion: acc.DIAS_RETENCION,
          // Si esto crece y no vuelve a bajar, el borrado automático no está
          // corriendo. Es la forma de que una falla silenciosa se vea.
          accesos_esperando_anonimizacion: pendientes,
          tablas: await revisarTablas(env),
        });
      }

      if (url.pathname === '/api/sesion') {
        if (request.method === 'POST') return await entrar(request, env, url);
        if (request.method === 'DELETE') {
          const seguro = url.protocol === 'https:';
          // Se borran las dos: quien cerró sesión cerró sesión, y no hay por
          // qué saber antes con cuál de las dos había entrado.
          const r = json({ ok: true });
          r.headers.append('set-cookie', cookieBorrada(seguro, 'acceso'));
          r.headers.append('set-cookie', cookieBorrada(seguro, 'acceso_oficina'));
          return r;
        }
        return error('Método no permitido', 405);
      }

      const quien = await identificar(request, env);
      if (!quien) return error('Sin sesión', 401);

      if (!(await tablasListas(env))) return faltaMigracion();

      return await api(request, env, url, quien);
    } catch (e) {
      if (e instanceof ErrorDatos) {
        console.error('Supabase:', e.status, e.message, JSON.stringify(e.detalle));
        // 42501 es «permission denied» de Postgres. Como al rol público se le
        // quitó todo acceso a propósito, verlo acá significa casi siempre que
        // SUPABASE_SERVICE_KEY tiene la clave publishable en vez de la secreta.
        if (e.detalle?.code === '42501') {
          return error(
            'La clave de Supabase configurada no tiene permisos: parece ser la ' +
            'publishable en vez de la secreta. Revise SUPABASE_SERVICE_KEY.', 500);
        }
        return error('La base de datos rechazó la operación: ' + e.message, 502);
      }
      console.error(e);
      return error('Algo falló en el servidor', 500);
    }
  },

  /**
   * El borrado automático de los datos de visitantes vencidos.
   *
   * Corre una vez al día por el disparador de `wrangler.jsonc`. Si alguien
   * desactivara el disparador, `/api/diagnostico` muestra cuántos registros
   * están esperando y el número deja de bajar: la falla se ve en vez de
   * quedarse callada. Y la oficina puede correrlo a mano desde la pantalla.
   */
  async scheduled(evento, env, ctx) {
    ctx.waitUntil((async () => {
      try {
        const cuantos = await acc.anonimizarViejos(env);
        console.log(`retención: ${cuantos} accesos anonimizados`);
      } catch (e) {
        console.error('retención:', e.message);
      }
    })());
  },
};
