/**
 * Las dos actas que se firman con el dedo: el certificado de cambio de turno y
 * el informe de evento especial.
 *
 * Están en el mismo archivo porque son el mismo mecanismo con dos textos
 * distintos: se arma un cuerpo, se congela, se le saca el SHA-256, y después
 * se le pegan firmas que guardan contra qué texto firmaron.
 *
 * Es el mismo patrón de `ADMINISTRACION/src/documentos.js`, y las tres
 * decisiones que lo explican son las mismas:
 *
 *  1. **El texto se congela al crear, no al imprimir.** Lo que se guarda es el
 *     acta ya escrita, no la plantilla más los datos. Si mañana se corrige el
 *     formato del certificado, lo ya firmado sigue diciendo lo que la persona
 *     leyó cuando firmó. Guardar la receta en vez del plato obligaría a
 *     confiar en que la receta no cambió, que es justo lo que no se puede
 *     probar.
 *  2. **El PDF es una impresión, no el registro.** El registro es el cuerpo
 *     congelado más las firmas; el PDF se puede rehacer idéntico cuantas veces
 *     se quiera y perderlo no pierde nada.
 *  3. **La firma guarda con qué se la puede defender.** Es firma electrónica
 *     simple de la Ley 19.799: vale, y entre las partes hace plena prueba
 *     mientras ninguna la objete. Lo que se discute cuando alguien la objeta
 *     es si se puede demostrar quién firmó y cuándo, y para eso se guardan la
 *     hora del servidor, la cuenta, el nombre y el RUT congelados, el hash del
 *     texto, la huella de la IP y el navegador.
 *
 * Lo que este sistema NO promete: firma electrónica avanzada. Eso exige un
 * certificado de un prestador acreditado que la empresa no tiene. El acta lo
 * dice impreso al pie, en vez de dejar que alguien suponga de más.
 */

import { buscar, primero, insertar, actualizar, anotar, ErrorDatos } from './datos.js';
import { formatearRut } from './rut.js';
import { fechaChile, horaChile, fechaLarga, esFecha } from './fechas.js';
import { contarEntre } from './novedades.js';

const LEY = 'Firmado electrónicamente conforme a la Ley N° 19.799 sobre documentos ' +
            'electrónicos y firma electrónica. Firma electrónica simple: su valor ' +
            'está dado por la identificación de quien firma, registrada por el ' +
            'sistema al momento de firmar.';

/** Los tipos de evento que ofrece la pantalla. «otro» siempre está. */
export const TIPOS_EVENTO = [
  'Denuncia',
  'Robo o hurto',
  'Intento de ingreso no autorizado',
  'Daño a la propiedad',
  'Accidente',
  'Agresión o amenaza',
  'Emergencia (incendio, derrame, sismo)',
  'Falla de equipamiento',
  'Otro',
];

export async function hash(texto) {
  const bytes = new TextEncoder().encode(texto);
  const resumen = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(resumen)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ------------------------------------------------------------- la empresa
/**
 * La razón social y el RUT con que se encabeza el acta.
 *
 * Sale de `datos_empresa`, que es donde ya vive para los contratos: escribirla
 * de nuevo acá sería tener dos respuestas a «con qué razón social firma esta
 * empresa», y el día que cambie una quedaría mintiendo la otra.
 *
 * `por_confirmar` viaja hasta la pantalla y hasta el pie del acta. Hoy la
 * razón social está marcada así, y mientras lo esté el acta lo dice en vez de
 * afirmarlo: es la misma costumbre que la página pública con lo que la empresa
 * no ha confirmado.
 */
export async function datosEmpresa(env) {
  try {
    const filas = await buscar(env, 'datos_empresa?select=codigo,valor,por_confirmar');
    const m = {};
    for (const f of filas) m[f.codigo] = f;
    return {
      razon_social: m.razon_social?.valor || 'GLOBSEG SPA',
      rut: m.rut?.valor || '',
      nombre_fantasia: m.nombre_fantasia?.valor || 'Seguridad Garridos',
      por_confirmar: filas.filter((f) => f.por_confirmar).map((f) => f.codigo),
    };
  } catch (e) {
    // La tabla vive en la migración de documentos del otro repositorio. Si
    // faltara, el acta se emite igual con el nombre de fantasía y lo dice: un
    // certificado de cambio de turno no se puede quedar sin emitir porque
    // falte el encabezado.
    console.error('datos_empresa:', e.message);
    return {
      razon_social: 'Seguridad Garridos',
      rut: '',
      nombre_fantasia: 'Seguridad Garridos',
      por_confirmar: ['razon_social'],
      sin_tabla: true,
    };
  }
}

const encabezado = (emp) =>
  [emp.razon_social + (emp.rut ? `  ·  RUT ${emp.rut}` : ''),
   emp.nombre_fantasia && emp.nombre_fantasia !== emp.razon_social
     ? emp.nombre_fantasia : null].filter(Boolean).join('\n');

// ------------------------------------------------------------ el correlativo
/**
 * Correlativo por año: CT-2026-0001, EV-2026-0001.
 *
 * Se calcula mirando el último del año y sumando uno. Dos guardias que creen
 * un acta en el mismo segundo pueden sacar el mismo número; lo que lo impide
 * de verdad es el índice único de la columna, y por eso quien llama reintenta.
 */
async function siguienteNumero(env, tabla, prefijo) {
  const anio = fechaChile().slice(0, 4);
  const ultimo = await primero(env,
    `${tabla}?select=numero&numero=like.${prefijo}-${anio}-*&order=numero.desc`);
  const n = ultimo ? Number(String(ultimo.numero).split('-')[2]) || 0 : 0;
  return `${prefijo}-${anio}-${String(n + 1).padStart(4, '0')}`;
}

/**
 * Inserta reintentando si el correlativo chocó.
 *
 * `armarFila` recibe el número y devuelve la fila **entera**, con el cuerpo ya
 * escrito y su hash. Se arma adentro del reintento y no antes porque el número
 * va impreso dentro del texto del informe de evento: si se volviera a intentar
 * con otro número sin rehacer el texto, el acta diría un número y la columna
 * diría otro, y el hash sería el del texto equivocado.
 *
 * Tres intentos: con dos personas creando a la vez, al segundo ya hay número
 * libre. Si el error no es el del número duplicado, se vuelve a lanzar tal
 * cual: esconderlo haría que un problema de la base se viera como un acta que
 * no se creó por ninguna razón.
 */
async function insertarConNumero(env, tabla, prefijo, armarFila) {
  let ultimo;
  for (let intento = 1; intento <= 3; intento++) {
    const numero = await siguienteNumero(env, tabla, prefijo);
    try {
      const [fila] = await insertar(env, tabla, await armarFila(numero));
      return fila;
    } catch (e) {
      const choque = e instanceof ErrorDatos &&
        (e.status === 409 || e.detalle?.code === '23505');
      if (!choque) throw e;
      ultimo = e;
    }
  }
  throw ultimo;
}

// ================================================= certificado de cambio de turno
/**
 * Arma el texto del certificado.
 *
 * Lleva dentro **lo que de verdad se entrega**: cuántas personas y vehículos
 * quedan adentro de la instalación y cuántas novedades se escribieron. Eso es
 * lo que se traspasa en un cambio de turno y es justamente lo que hoy se dice
 * de palabra y nadie anota. Son datos que el sistema ya tiene; pedirle al
 * guardia que los escriba sería pedirle que copie a mano lo que está en la
 * pantalla de al lado.
 */
function cuerpoCertificado({ emp, instalacion, cuando, sale, entra, entrega,
                             adentro, novedades, desdeTexto }) {
  const lineas = [];
  lineas.push(encabezado(emp));
  lineas.push('');
  lineas.push('CERTIFICADO DE CAMBIO DE TURNO');
  lineas.push('');
  lineas.push(`Instalación: ${instalacion}`);
  lineas.push(`Fecha: ${fechaLarga(cuando)}, a las ${horaChile(cuando)} horas.`);
  lineas.push('');
  lineas.push('En la fecha y hora indicadas se deja constancia del cambio de turno ' +
              'del servicio de vigilancia, entre las personas que suscriben:');
  lineas.push('');
  lineas.push(`SE RETIRA:  ${sale.nombre}${sale.rut ? `, RUN ${formatearRut(sale.rut)}` : ''}`);
  lineas.push(`INGRESA:    ${entra.nombre}${entra.rut ? `, RUN ${formatearRut(entra.rut)}` : ''}`);
  lineas.push('');
  lineas.push('ESTADO DEL PUESTO AL MOMENTO DEL RELEVO');
  lineas.push('');
  lineas.push(`  Personas y vehículos dentro de la instalación: ${adentro.total}` +
              (adentro.total
                ? ` (${adentro.personas} sin vehículo, ${adentro.vehiculos} con vehículo)`
                : ''));
  for (const a of adentro.lista) {
    lineas.push(`    · ${a}`);
  }
  lineas.push(`  Novedades registradas ${desdeTexto}: ${novedades}`);
  lineas.push('');
  lineas.push('SE ENTREGA');
  lineas.push('');
  // Lo que no se escribió se dice con palabras, no con una línea de guiones:
  // un acta no se firma con un hueco adentro.
  lineas.push(entrega
    ? entrega.split('\n').map((l) => '  ' + l.trim()).join('\n')
    : '  No se dejó constancia de entrega de equipamiento ni de llaves.');
  lineas.push('');
  lineas.push('Quien se retira declara haber entregado el puesto en las condiciones ' +
              'descritas, y quien ingresa declara recibirlo conforme.');
  lineas.push('');
  lineas.push(LEY);
  if (emp.por_confirmar.includes('razon_social')) {
    lineas.push('');
    lineas.push('Nota: la razón social con que se emite este documento está pendiente ' +
                'de confirmación por la gerencia.');
  }
  return lineas.join('\n');
}

/** Quién y qué sigue adentro, para el certificado. */
async function queQuedaAdentro(env, instalacionId) {
  const filas = await buscar(env,
    `v_accesos?select=nombre,run,patente,vehiculo_tipo,empresa,entrada_en` +
    `&instalacion_id=eq.${instalacionId}&salida_en=is.null&order=entrada_en.asc&limit=100`);
  const lista = filas.map((f) => {
    const quien = f.nombre || (f.run ? formatearRut(f.run) : 'Sin identificar');
    const veh = f.patente ? ` · ${f.vehiculo_tipo || 'vehículo'} ${f.patente}` : '';
    const emp = f.empresa ? ` (${f.empresa})` : '';
    return `${quien}${emp}${veh} · desde las ${horaChile(f.entrada_en)}`;
  });
  return {
    total: filas.length,
    vehiculos: filas.filter((f) => f.patente).length,
    personas: filas.filter((f) => !f.patente).length,
    lista,
  };
}

/** Busca al trabajador por id, o arma uno escrito a mano. */
async function parteDelTurno(env, id, nombreEscrito, rotulo) {
  if (id != null && id !== '') {
    const n = Number(id);
    const t = Number.isInteger(n) && n > 0
      ? await primero(env, `trabajadores?select=id,nombre,rut&id=eq.${n}`) : null;
    if (!t) return { error: `No se encontró a la persona que ${rotulo}`, status: 404 };
    return { id: t.id, nombre: t.nombre, rut: t.rut };
  }
  // A mano: pasa de verdad con un relevo de otra empresa o con alguien recién
  // contratado a quien todavía no le crearon la cuenta. Negarse a emitir el
  // certificado dejaría el cambio de turno sin constancia, que es lo que se
  // está tratando de arreglar.
  const nombre = String(nombreEscrito ?? '').replace(/\s+/g, ' ').trim();
  if (!nombre) return { error: `Escriba quién ${rotulo}`, status: 400 };
  return { id: null, nombre: nombre.slice(0, 120), rut: null };
}

export async function crearCertificado(env, cuerpo, quien) {
  const instalacionId = Number(cuerpo.instalacion_id);
  const instalacion = Number.isInteger(instalacionId) && instalacionId > 0
    ? await primero(env, `instalaciones?select=id,nombre&id=eq.${instalacionId}`) : null;
  if (!instalacion) return { error: 'Elija la instalación del cambio de turno', status: 400 };

  const sale = await parteDelTurno(env, cuerpo.sale_trabajador_id, cuerpo.sale_nombre, 'se retira');
  if (sale.error) return sale;
  const entra = await parteDelTurno(env, cuerpo.entra_trabajador_id, cuerpo.entra_nombre, 'ingresa');
  if (entra.error) return entra;

  if (sale.id && entra.id && sale.id === entra.id) {
    return { error: 'La misma persona no puede retirarse y entrar en el mismo relevo', status: 400 };
  }

  const ahora = new Date();
  const emp = await datosEmpresa(env);
  const adentro = await queQuedaAdentro(env, instalacion.id);
  // Las novedades del turno que termina. Doce horas es el turno largo que se
  // usa en los parques; no se pregunta porque nadie lo sabe de memoria y
  // ponerlo mal haría que el certificado dijera un número que no es.
  const desde = new Date(ahora.getTime() - 12 * 3600000);
  const novedades = await contarEntre(env, instalacion.id,
    desde.toISOString(), ahora.toISOString()).catch(() => 0);

  const entrega = String(cuerpo.entrega ?? '').trim().slice(0, 2000) || null;

  // El número no va impreso dentro del certificado, así que el texto es el
  // mismo caiga el correlativo donde caiga: se arma una vez.
  const texto = cuerpoCertificado({
    emp, instalacion: instalacion.nombre, cuando: ahora,
    sale, entra, entrega, adentro, novedades,
    desdeTexto: 'en las últimas 12 horas',
  });
  const cuerpoHash = await hash(texto);

  const fila = await insertarConNumero(env, 'cambios_turno', 'CT', (numero) => ({
    numero,
    instalacion_id: instalacion.id,
    instalacion_nombre: instalacion.nombre,
    cuando: ahora.toISOString(),
    fecha: fechaChile(ahora),
    sale_trabajador_id: sale.id,
    sale_nombre: sale.nombre,
    sale_rut: sale.rut,
    entra_trabajador_id: entra.id,
    entra_nombre: entra.nombre,
    entra_rut: entra.rut,
    entrega,
    cuerpo: texto,
    cuerpo_hash: cuerpoHash,
    creado_por: quien.usuario,
  }));

  await anotar(env, quien.usuario, 'cambio_turno', fila.id, 'emitió un certificado de cambio de turno',
    `${fila.numero} · ${instalacion.nombre} · sale ${sale.nombre}, entra ${entra.nombre}`);

  return { certificado: { ...fila, firmas: [] }, por_confirmar: emp.por_confirmar };
}

// ==================================================== informe de evento especial
function cuerpoEvento({ emp, e, autor }) {
  const lineas = [];
  lineas.push(encabezado(emp));
  lineas.push('');
  lineas.push('INFORME DE EVENTO ESPECIAL');
  lineas.push(`N° ${e.numero}`);
  lineas.push('');
  lineas.push(`Instalación: ${e.instalacion_nombre}`);
  lineas.push(`Tipo de evento: ${e.tipo}`);
  lineas.push(`Ocurrido el: ${fechaLarga(e.ocurrido_en)}, a las ${horaChile(e.ocurrido_en)} horas.`);
  if (e.lugar) lineas.push(`Lugar preciso: ${e.lugar}`);
  lineas.push(`Informa: ${autor.nombre}${autor.rut ? `, RUN ${formatearRut(autor.rut)}` : ''}`);
  lineas.push('');
  lineas.push('PERSONAS O BIENES INVOLUCRADOS');
  lineas.push('');
  lineas.push(e.involucrados
    ? '  ' + e.involucrados.split('\n').map((l) => l.trim()).join('\n  ')
    : '  No se identificaron personas ni bienes involucrados.');
  lineas.push('');
  lineas.push('RELATO DE LO OCURRIDO');
  lineas.push('');
  lineas.push('  ' + e.relato.split('\n').map((l) => l.trim()).join('\n  '));
  lineas.push('');
  lineas.push('MEDIDAS ADOPTADAS');
  lineas.push('');
  lineas.push(e.medidas
    ? '  ' + e.medidas.split('\n').map((l) => l.trim()).join('\n  ')
    : '  No se dejó constancia de medidas adoptadas.');
  lineas.push('');
  lineas.push('AVISO A LA AUTORIDAD');
  lineas.push('');
  lineas.push(e.policia
    ? '  Sí. ' + (e.policia_detalle || 'No se dejó constancia del detalle del aviso.')
    : '  No se dio aviso a Carabineros ni a la Policía de Investigaciones.');
  lineas.push('');
  lineas.push('El firmante declara que lo relatado corresponde a lo que presenció o ' +
              'constató personalmente en el ejercicio de sus funciones.');
  lineas.push('');
  lineas.push(LEY);
  return lineas.join('\n');
}

export async function crearEvento(env, cuerpo, quien) {
  const instalacionId = Number(cuerpo.instalacion_id);
  const instalacion = Number.isInteger(instalacionId) && instalacionId > 0
    ? await primero(env, `instalaciones?select=id,nombre&id=eq.${instalacionId}`) : null;
  if (!instalacion) return { error: 'Elija en qué instalación ocurrió', status: 400 };

  const relato = String(cuerpo.relato ?? '').trim();
  if (relato.length < 20) {
    return {
      error: 'Cuente qué pasó con algo más de detalle: este informe es el que ' +
             'después se le entrega al cliente o se lleva a Carabineros.',
      status: 400,
    };
  }
  if (relato.length > 8000) return { error: 'El relato es demasiado largo', status: 400 };

  const tipo = String(cuerpo.tipo ?? '').trim().slice(0, 80);
  if (!tipo) return { error: 'Elija de qué tipo es el evento', status: 400 };

  // Cuándo ocurrió, que no es cuándo se escribe. Llega como fecha y hora de
  // Chile desde la pantalla; sin eso, un evento de las 03:00 redactado a las
  // 07:00 quedaría fechado a las 07:00 y el informe diría otra cosa que el
  // relato.
  const ocurrido = instanteChileno(cuerpo.ocurrido_fecha, cuerpo.ocurrido_hora);
  if (!ocurrido) return { error: 'Escriba cuándo ocurrió, con fecha y hora', status: 400 };
  const ahora = new Date();
  if (ocurrido.getTime() > ahora.getTime() + 5 * 60000) {
    return { error: 'La fecha y hora del evento todavía no ocurren', status: 400 };
  }

  const emp = await datosEmpresa(env);
  const base = {
    instalacion_nombre: instalacion.nombre,
    tipo,
    ocurrido_en: ocurrido,
    lugar: limpiar(cuerpo.lugar, 200),
    involucrados: limpiar(cuerpo.involucrados, 2000),
    relato,
    medidas: limpiar(cuerpo.medidas, 2000),
    policia: cuerpo.policia === true || cuerpo.policia === 'true',
    policia_detalle: limpiar(cuerpo.policia_detalle, 300),
  };

  // Acá el texto sí se rehace en cada intento: el número va impreso adentro
  // del informe, así que un correlativo distinto es otro documento.
  const fila = await insertarConNumero(env, 'eventos_especiales', 'EV', async (numero) => {
    const texto = cuerpoEvento({ emp, e: { ...base, numero }, autor: quien });
    return {
      numero,
      instalacion_id: instalacion.id,
      instalacion_nombre: instalacion.nombre,
      tipo: base.tipo,
      ocurrido_en: ocurrido.toISOString(),
      fecha: fechaChile(ocurrido),
      lugar: base.lugar,
      involucrados: base.involucrados,
      relato: base.relato,
      medidas: base.medidas,
      policia: base.policia,
      policia_detalle: base.policia ? base.policia_detalle : null,
      lat: numeroONulo(cuerpo.lat, -90, 90),
      lon: numeroONulo(cuerpo.lon, -180, 180),
      cuerpo: texto,
      cuerpo_hash: await hash(texto),
      creado_por: quien.usuario,
      creado_por_nombre: quien.nombre,
    };
  });

  await anotar(env, quien.usuario, 'evento', fila.id, 'informó un evento especial',
    `${fila.numero} · ${instalacion.nombre} · ${tipo}`);

  return { evento: { ...fila, firmas: [] }, por_confirmar: emp.por_confirmar };
}

const limpiar = (v, largo) => {
  const t = String(v ?? '').trim();
  return t ? t.slice(0, largo) : null;
};

function numeroONulo(v, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) return null;
  return n;
}

/**
 * El instante exacto en que, en Chile, el reloj marcaba esa fecha y esa hora.
 *
 * Se pregunta el desfase por instante en vez de fijarlo como constante porque
 * Chile cambia la hora dos veces al año: un evento de julio y uno de enero no
 * tienen el mismo desfase, y con uno fijo la mitad del año quedaría corrida.
 */
export function instanteChileno(fecha, hora) {
  if (!esFecha(fecha) || !/^\d{2}:\d{2}$/.test(String(hora ?? ''))) return null;
  const tentativo = new Date(`${fecha}T${hora}:00Z`);
  if (Number.isNaN(tentativo.getTime())) return null;
  let d = tentativo;
  // Dos pasadas: la primera corrige el desfase, la segunda lo recalcula por si
  // el instante corregido cayó al otro lado de un cambio de hora.
  for (let i = 0; i < 2; i++) {
    const desfase = desfaseChile(d);
    d = new Date(tentativo.getTime() - desfase * 60000);
  }
  return d;
}

function desfaseChile(d) {
  try {
    const f = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Santiago',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    });
    const [dia, hora] = f.format(d).split(', ');
    return (Date.parse(`${dia}T${hora}Z`) - d.getTime()) / 60000;
  } catch {
    return -180;
  }
}

// ================================================================== firmar
const ROLES = {
  cambio_turno: { sale: 'Quien se retira', entra: 'Quien ingresa' },
  evento: { autor: 'Quien informa', testigo: 'Testigo' },
};

const TABLA = { cambio_turno: 'cambios_turno', evento: 'eventos_especiales' };
const VISTA = { cambio_turno: 'v_cambios_turno', evento: 'v_eventos' };

/**
 * Pega una firma.
 *
 * Tres cosas que se niega a hacer, y cada una es el motivo por el que esta
 * firma sirve de algo:
 *
 *  - Firmar un acta anulada.
 *  - Repetir un rol ya firmado. Una firma no se corrige: si estaba mal, se
 *    anula el acta y se hace otra. Dejar reescribir una firma sería dejar
 *    reescribir la prueba. La base lo impide igual con un índice único; acá se
 *    revisa antes para poder decir por qué.
 *  - Firmar sin marcar que se leyó. No es un trámite: es la única diferencia
 *    entre una firma y un trazo en una pantalla.
 */
export async function firmar(env, entidad, id, cuerpo, quien, request) {
  if (!TABLA[entidad]) return { error: 'No se puede firmar eso', status: 400 };

  const rol = String(cuerpo.rol ?? '').trim();
  if (!ROLES[entidad][rol]) {
    return { error: 'No se sabe en calidad de qué está firmando', status: 400 };
  }
  if (cuerpo.leido !== true) {
    return { error: 'Marque que leyó el documento antes de firmar', status: 400 };
  }

  const imagen = String(cuerpo.imagen ?? '');
  if (!imagen.startsWith('data:image/png;base64,') || imagen.length < 200) {
    return { error: 'No llegó la firma. Dibújela de nuevo.', status: 400 };
  }
  // Una firma de más de 400 KB no es una firma: es una foto. El lienzo entrega
  // entre 5 y 40 KB.
  if (imagen.length > 400_000) {
    return { error: 'La firma pesa demasiado. Dibújela de nuevo.', status: 400 };
  }

  const acta = await primero(env, `${TABLA[entidad]}?select=*&id=eq.${Number(id)}`);
  if (!acta) return { error: 'Ese documento no existe', status: 404 };
  if (acta.estado === 'anulado') {
    return { error: 'Ese documento está anulado: no se puede firmar', status: 409 };
  }

  const yaFirmado = await primero(env,
    `firmas_acceso?select=id,nombre&entidad=eq.${entidad}&entidad_id=eq.${acta.id}` +
    `&rol=eq.${encodeURIComponent(rol)}`);
  if (yaFirmado) {
    return {
      error: `«${ROLES[entidad][rol]}» ya firmó este documento (${yaFirmado.nombre}). ` +
             'Una firma no se reemplaza: si está mal, anule el documento y emita otro.',
      status: 409,
    };
  }

  // El nombre y el RUT con que se firma. Si quien firma es la persona que el
  // acta nombra, se usan los del acta —que ya están congelados—; si no, los de
  // la cuenta que tiene la sesión abierta. Nunca se le pregunta a la pantalla:
  // un nombre que viene del navegador es un nombre que alguien pudo escribir.
  const delActa = nombreDelActa(entidad, rol, acta);
  const nombre = delActa.nombre || quien.nombre;
  const rut = delActa.rut || quien.rut || null;

  await insertar(env, 'firmas_acceso', {
    entidad,
    entidad_id: acta.id,
    rol,
    nombre,
    rut,
    imagen,
    cuerpo_hash: acta.cuerpo_hash,
    quien: quien.usuario,
    ip_huella: await huellaIp(request, env),
    agente: (request.headers.get('user-agent') || '').slice(0, 300) || null,
  });

  // El acta queda firmada cuando están todas las firmas que pide.
  const firmas = await buscar(env,
    `firmas_acceso?select=rol&entidad=eq.${entidad}&entidad_id=eq.${acta.id}`);
  const obligatorias = entidad === 'cambio_turno' ? ['sale', 'entra'] : ['autor'];
  const completo = obligatorias.every((r) => firmas.some((f) => f.rol === r));
  let estado = acta.estado;
  if (completo && acta.estado !== 'firmado') {
    const [act] = await actualizar(env, `${TABLA[entidad]}?id=eq.${acta.id}`,
      { estado: 'firmado' });
    estado = act.estado;
  }

  await anotar(env, quien.usuario, entidad, acta.id, 'firmó',
    `${acta.numero} · ${ROLES[entidad][rol]} · ${nombre}`);

  return {
    ok: true,
    estado,
    firmas: firmas.length,
    faltan: obligatorias.filter((r) => !firmas.some((f) => f.rol === r))
                        .map((r) => ROLES[entidad][r]),
  };
}

function nombreDelActa(entidad, rol, acta) {
  if (entidad === 'cambio_turno' && rol === 'sale') {
    return { nombre: acta.sale_nombre, rut: acta.sale_rut };
  }
  if (entidad === 'cambio_turno' && rol === 'entra') {
    return { nombre: acta.entra_nombre, rut: acta.entra_rut };
  }
  if (entidad === 'evento' && rol === 'autor') {
    return { nombre: acta.creado_por_nombre, rut: null };
  }
  return { nombre: null, rut: null };
}

async function huellaIp(request, env) {
  const ip = request.headers.get('cf-connecting-ip') ||
             (request.headers.get('x-forwarded-for') || '').split(',')[0].trim();
  if (!ip) return null;
  const datos = new TextEncoder().encode((env.SESION_SECRETO || '') + '|' + ip);
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', datos));
  return Array.from(bytes.slice(0, 16), (b) => b.toString(16).padStart(2, '0')).join('');
}

// ================================================================= anular
/**
 * Anula un acta. No la borra: la marca y deja las firmas puestas.
 *
 * Las firmas quedan porque pasaron: alguien firmó ese texto ese día, y borrar
 * eso sería borrar el hecho. Lo que cambia es que el acta deja de valer, y se
 * dice con qué motivo y quién lo decidió.
 */
export async function anular(env, entidad, id, motivo, quien) {
  if (!TABLA[entidad]) return { error: 'No se puede anular eso', status: 400 };
  const m = String(motivo ?? '').trim();
  if (m.length < 5) {
    return { error: 'Escriba por qué se anula: queda escrito en el documento', status: 400 };
  }

  const acta = await primero(env, `${TABLA[entidad]}?select=id,numero,estado&id=eq.${Number(id)}`);
  if (!acta) return { error: 'Ese documento no existe', status: 404 };
  if (acta.estado === 'anulado') return { error: 'Ya estaba anulado', status: 409 };

  const [fila] = await actualizar(env, `${TABLA[entidad]}?id=eq.${acta.id}`,
    { estado: 'anulado', anulado_motivo: m.slice(0, 500) });

  await anotar(env, quien.usuario, entidad, acta.id, 'anuló', `${acta.numero} · ${m.slice(0, 200)}`);
  return { ok: true, documento: fila };
}

// ================================================================= leer
export async function listarActas(env, entidad, p) {
  if (!VISTA[entidad]) return { error: 'No existe eso', status: 404 };
  const filtros = [];
  const inst = Number(p.get('instalacion'));
  if (Number.isInteger(inst) && inst > 0) filtros.push(`instalacion_id=eq.${inst}`);

  const desde = esFecha(p.get('desde')) ? p.get('desde') : null;
  const hasta = esFecha(p.get('hasta')) ? p.get('hasta') : null;
  if (desde) filtros.push(`fecha=gte.${desde}`);
  if (hasta) filtros.push(`fecha=lte.${hasta}`);

  const tope = Math.min(Math.max(Number(p.get('tope')) || 100, 1), 500);
  // La vista trae el cuerpo entero de cada acta, que son miles de caracteres.
  // El listado no lo necesita y pedirlo haría que abrir la pestaña bajara
  // cientos de kilobytes por la red del parque.
  const columnas = entidad === 'cambio_turno'
    ? 'id,numero,instalacion_id,instalacion_nombre,cuando,fecha,sale_nombre,entra_nombre,estado,anulado_motivo,firmas,firmas_descuadradas,creado_por'
    : 'id,numero,instalacion_id,instalacion_nombre,tipo,ocurrido_en,fecha,lugar,policia,estado,anulado_motivo,firmas,firmas_descuadradas,creado_por,creado_por_nombre';

  const filas = await buscar(env,
    `${VISTA[entidad]}?select=${columnas}&${filtros.join('&')}&order=id.desc&limit=${tope}`);
  return { [entidad === 'cambio_turno' ? 'certificados' : 'eventos']: filas };
}

/** Un acta con su cuerpo y sus firmas, para leerla, firmarla o imprimirla. */
export async function verActa(env, entidad, id) {
  if (!VISTA[entidad]) return { error: 'No existe eso', status: 404 };
  const acta = await primero(env, `${VISTA[entidad]}?select=*&id=eq.${Number(id)}`);
  if (!acta) return { error: 'Ese documento no existe', status: 404 };

  const firmas = await buscar(env,
    `firmas_acceso?select=*&entidad=eq.${entidad}&entidad_id=eq.${acta.id}&order=firmado_en.asc`);

  const obligatorias = entidad === 'cambio_turno' ? ['sale', 'entra'] : ['autor'];
  return {
    documento: acta,
    firmas: firmas.map((f) => ({ ...f, rol_nombre: ROLES[entidad][f.rol] || f.rol })),
    roles: ROLES[entidad],
    faltan: obligatorias.filter((r) => !firmas.some((f) => f.rol === r)),
    // Si alguna firma no calza con el texto de hoy, la pantalla lo dice en vez
    // de mostrar como firmado algo que ya no es lo que se firmó. No debería
    // pasar nunca —el cuerpo no se edita— y justamente por eso, si pasa, hay
    // que verlo.
    descuadrado: firmas.some((f) => f.cuerpo_hash !== acta.cuerpo_hash),
  };
}
