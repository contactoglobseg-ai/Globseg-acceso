

-- =============================================================================
-- Control de acceso en terreno (acceso.seggarridos.com)
--
-- Cuatro cosas que hoy son papel en la caseta del puesto: quién entró y salió,
-- qué vehículo, el libro de novedades del turno, el certificado de cambio de
-- turno y el informe de un evento especial (una denuncia, un robo, un daño).
--
-- Tres decisiones que explican la forma de estas tablas:
--
--  1. **Un acceso es una fila, venga a pie o en camioneta.** No hay una tabla
--     de personas y otra de vehículos. En una portería lo que se anota es «a
--     las 09:14 entró esto», y quien maneja es una persona con nombre y RUN.
--     Separarlos obligaría al guardia a llenar dos formularios por la misma
--     camioneta, y a la oficina a cruzar dos listas para responder quién
--     estaba adentro a tal hora, que es la única pregunta que se le hace de
--     verdad a este registro.
--
--  2. **Nada se edita ni se borra.** Es lo mismo que hace valer el libro de
--     asistencia. Una novedad mal escrita se corrige escribiendo otra que
--     apunta a ella (`corrige_id`); un certificado o un evento equivocados se
--     anulan con motivo y se hace uno nuevo. Un libro que se puede retocar no
--     sirve de respaldo frente a un reclamo, que es justamente para lo que se
--     construye éste.
--
--  3. **Los datos del visitante caducan.** Un visitante no trabaja acá y no
--     firmó nada: su RUN está en esta base porque alguien tenía que anotar
--     quién entró, y ese motivo se termina. Al año `anonimizar_accesos()` le
--     borra el RUN, el nombre, la patente y a quién venía a ver, y deja el
--     hecho: qué día, a qué hora, a qué instalación y si traía vehículo. Así
--     el registro sigue sirviendo para contar y deja de ser una lista de
--     personas. Ver el comentario de la función, más abajo.
--
-- Comparte base y cuentas con el resto del sistema: las personas que entran a
-- esta aplicación son las mismas filas de `trabajadores` (los guardias, con la
-- cuenta con que marcan turno) y de `usuarios` (las cuatro de oficina). No se
-- crea un tercer registro de personas.
--
-- Esta migración se puede correr las veces que sea: no duplica nada.
-- =============================================================================

-- ============================================================ 1. los accesos
--
-- `run` va normalizado —sin puntos ni guión, con el dígito verificador y la K
-- en mayúscula—, igual que en `trabajadores`, porque si cada pantalla lo
-- guardara a su manera el mismo visitante aparecería como tres personas y
-- «¿cuántas veces entró este señor?» no tendría respuesta.
--
-- Puede quedar en null a propósito: un repartidor que llega sin cédula se
-- registra igual con su nombre y su patente. Perder el registro del ingreso
-- por no tener un dato es peor que tener el registro incompleto, y `origen_run`
-- deja dicho cuál de los tres casos fue.
create table if not exists accesos (
  id                bigint generated always as identity primary key,
  instalacion_id    bigint references instalaciones(id) on delete set null,

  -- quién entra
  run               text,
  nombre            text,
  empresa           text,

  -- De dónde salió el RUN. Importa para el valor del registro: uno leído del
  -- QR de la cédula lo puso el documento, uno escrito a mano lo puso el
  -- guardia mirando el carnet, y «sin_documento» es que no hubo carnet que
  -- mirar. Las tres cosas son registros válidos y no valen lo mismo.
  origen_run        text not null default 'manual'
                    check (origen_run in ('qr', 'manual', 'sin_documento')),

  -- Lo que viene dentro del QR de la cédula además del RUN. `documento_vence`
  -- es el dato que hace que esto sirva de algo más que de tipeo rápido: deja
  -- ver en el momento que el carnet está vencido.
  documento_tipo    text,
  documento_serie   text,
  documento_vence   date,

  -- a qué viene
  motivo            text,
  a_quien_visita    text,

  -- El vehículo, cuando lo hay. Una fila sin patente es alguien que entró a
  -- pie; no hace falta otra tabla para decir eso.
  patente           text,
  vehiculo_tipo     text,
  vehiculo_detalle  text,
  acompanantes      integer not null default 0 check (acompanantes >= 0),

  -- cuándo
  entrada_en        timestamptz not null default now(),
  salida_en         timestamptz,
  -- Día del turno en hora de Chile, igual que en `marcas`. Sin esto, todo lo
  -- que entra después de las 21:00 aparecería al día siguiente en el listado.
  fecha             date not null,

  -- quién lo registró, congelado: la cuenta puede darse de baja y el registro
  -- tiene que seguir diciendo quién lo escribió.
  registrado_por        text not null,
  registrado_por_nombre text,
  salida_por            text,
  salida_por_nombre     text,

  lat               double precision,
  lon               double precision,
  nota              text,

  -- Queda escrito el día en que se le borraron los datos personales. Null es
  -- «todavía tiene los datos»; con fecha, los campos de arriba están en null
  -- porque los borró la retención y no porque nadie los haya escrito.
  anonimizado_en    timestamptz,

  creado_en         timestamptz not null default now(),

  constraint acceso_salida_despues check (salida_en is null or salida_en >= entrada_en)
);

create index if not exists idx_acc_inst_fecha on accesos(instalacion_id, fecha desc);
create index if not exists idx_acc_fecha      on accesos(fecha desc);
create index if not exists idx_acc_entrada    on accesos(entrada_en desc);
create index if not exists idx_acc_run        on accesos(run) where run is not null;
create index if not exists idx_acc_patente    on accesos(patente) where patente is not null;
-- El índice que importa en la caseta: quiénes siguen adentro. Es la pantalla
-- que el guardia mira todo el turno, y es parcial porque las filas cerradas
-- son el 99% de la tabla y no tienen nada que hacer en ese índice.
create index if not exists idx_acc_adentro    on accesos(instalacion_id, entrada_en desc)
  where salida_en is null;
-- Para la retención: encuentra lo que ya caducó sin recorrer la tabla entera.
create index if not exists idx_acc_porAnonimizar on accesos(entrada_en)
  where anonimizado_en is null;

comment on table accesos is
  'Una fila por ingreso a una instalación, de una persona y su vehículo si lo trae. No se edita ni se borra: la salida se marca escribiendo salida_en.';
comment on column accesos.run is
  'RUN normalizado, sin puntos ni guión. Se borra al año por anonimizar_accesos().';
comment on column accesos.origen_run is
  'qr: leído del código de la cédula. manual: tecleado por el guardia. sin_documento: no hubo carnet.';
comment on column accesos.anonimizado_en is
  'Cuándo se le borraron los datos personales. Null = todavía los tiene.';

-- ========================================================= 2. las novedades
--
-- El libro de novedades del puesto. Una fila por anotación, con la hora en que
-- se escribió y quién la escribió, los dos puestos por el servidor.
--
-- No se edita ni se borra, por lo mismo que el libro de asistencia: una
-- anotación que se puede retocar después no prueba nada. Una corrección es una
-- fila nueva que apunta a la vieja con `corrige_id`, y las dos quedan a la
-- vista. Es exactamente lo que se hace en un libro de papel cuando se escribe
-- mal: no se arranca la hoja, se escribe debajo.
create table if not exists novedades (
  id              bigint generated always as identity primary key,
  instalacion_id  bigint references instalaciones(id) on delete set null,
  trabajador_id   bigint references trabajadores(id) on delete set null,

  -- Congelados: la cuenta puede darse de baja o cambiar de nombre, y la
  -- anotación tiene que seguir diciendo quién la hizo.
  quien           text not null,
  quien_nombre    text not null,

  cuando          timestamptz not null default now(),
  fecha           date not null,

  categoria       text not null default 'novedad'
                  check (categoria in ('novedad', 'ronda', 'incidencia',
                                       'entrega_turno', 'otro')),
  texto           text not null check (length(btrim(texto)) > 0),

  lat             double precision,
  lon             double precision,

  corrige_id      bigint references novedades(id) on delete set null,

  creada_en       timestamptz not null default now()
);

create index if not exists idx_nov_inst_fecha on novedades(instalacion_id, fecha desc);
create index if not exists idx_nov_fecha      on novedades(fecha desc);
create index if not exists idx_nov_cuando     on novedades(cuando desc);
create index if not exists idx_nov_corrige    on novedades(corrige_id) where corrige_id is not null;

comment on table novedades is
  'Libro de novedades del puesto. No se edita ni se borra: una corrección es otra fila con corrige_id apuntando a la anotación que corrige.';

-- ================================================= 3. los cambios de turno
--
-- El certificado de cambio de turno: quién se retira, quién ingresa, y qué se
-- entregó. Lo firman los dos con el dedo.
--
-- `cuerpo` es el texto ya armado y congelado, no la plantilla más los datos.
-- Es la misma decisión que en los documentos de RRHH y por el mismo motivo: lo
-- que se firmó tiene que seguir diciendo lo que la persona leyó cuando firmó,
-- aunque mañana se corrija el formato del certificado. Guardar la receta en vez
-- del plato obligaría a confiar en que la receta no cambió, que es justo lo que
-- no se puede probar.
create table if not exists cambios_turno (
  id                   bigint generated always as identity primary key,
  numero               text not null unique,
  instalacion_id       bigint references instalaciones(id) on delete set null,
  instalacion_nombre   text not null,

  cuando               timestamptz not null default now(),
  fecha                date not null,

  -- Los dos, congelados. El id queda para poder enlazar; el nombre y el RUT
  -- son los que valen, porque si alguien corrige una ficha el año que viene el
  -- certificado tiene que seguir diciendo con qué datos se firmó.
  sale_trabajador_id   bigint references trabajadores(id) on delete set null,
  sale_nombre          text not null,
  sale_rut             text,
  entra_trabajador_id  bigint references trabajadores(id) on delete set null,
  entra_nombre         text not null,
  entra_rut            text,

  entrega              text,

  cuerpo               text not null,
  cuerpo_hash          text not null,

  estado               text not null default 'pendiente'
                       check (estado in ('pendiente', 'firmado', 'anulado')),
  anulado_motivo       text,

  creado_por           text not null,
  creado_en            timestamptz not null default now()
);

create index if not exists idx_ct_inst_fecha on cambios_turno(instalacion_id, fecha desc);
create index if not exists idx_ct_fecha      on cambios_turno(fecha desc);
create index if not exists idx_ct_estado     on cambios_turno(estado);

comment on table cambios_turno is
  'Certificado de cambio de turno. El cuerpo se congela al crearlo; lo firman con el dedo el que sale y el que entra.';

-- ================================================== 4. los eventos especiales
--
-- Una denuncia, un robo, un daño, una agresión, un accidente. Es el documento
-- que después se le entrega al cliente o se lleva a Carabineros, así que se
-- congela y se firma igual que el certificado.
create table if not exists eventos_especiales (
  id                 bigint generated always as identity primary key,
  numero             text not null unique,
  instalacion_id     bigint references instalaciones(id) on delete set null,
  instalacion_nombre text not null,

  tipo               text not null,
  -- Cuándo ocurrió, que no es cuándo se escribió: un evento de las 03:00 se
  -- suele redactar a las 07:00, cuando llega el relevo.
  ocurrido_en        timestamptz not null,
  fecha              date not null,
  lugar              text,
  involucrados       text,
  relato             text not null check (length(btrim(relato)) > 0),
  medidas            text,

  -- Si se avisó a Carabineros o a la PDI, y con qué número de parte. Es el
  -- primer dato que pregunta el cliente y el que nadie anota.
  policia            boolean not null default false,
  policia_detalle    text,

  cuerpo             text not null,
  cuerpo_hash        text not null,

  estado             text not null default 'pendiente'
                     check (estado in ('pendiente', 'firmado', 'anulado')),
  anulado_motivo     text,

  lat                double precision,
  lon                double precision,

  creado_por         text not null,
  creado_por_nombre  text not null,
  creado_en          timestamptz not null default now()
);

create index if not exists idx_ev_inst_fecha on eventos_especiales(instalacion_id, fecha desc);
create index if not exists idx_ev_fecha      on eventos_especiales(fecha desc);
create index if not exists idx_ev_estado     on eventos_especiales(estado);

comment on table eventos_especiales is
  'Informe de evento especial. El cuerpo se congela al crearlo y lo firma con el dedo quien lo reporta.';

-- =========================================================== 5. las firmas
--
-- Una sola tabla para las firmas de los certificados y de los eventos.
--
-- Va polimórfica (`entidad` + `entidad_id`) y no con dos claves foráneas
-- porque lo que se guarda es el acto de firmar, que es idéntico en los dos
-- casos, y porque ninguna de las dos tablas de arriba se borra nunca: lo que
-- está mal se anula con motivo y queda. Sin borrados no hay filas huérfanas
-- que una clave foránea tuviera que impedir. Queda dicho el costo: la base no
-- puede verificar sola que `entidad_id` exista, y eso lo cuida el Worker.
--
-- Qué guarda cada firma, y por qué cada cosa. Es firma electrónica simple de
-- la Ley 19.799: vale, y entre las partes hace plena prueba mientras ninguna
-- la objete. Lo que se discute cuando alguien la objeta es si se puede
-- demostrar quién firmó y cuándo, y para eso es cada una de estas columnas.
create table if not exists firmas_acceso (
  id          bigint generated always as identity primary key,

  entidad     text not null check (entidad in ('cambio_turno', 'evento')),
  entidad_id  bigint not null,
  rol         text not null,

  -- Congelados al momento de firmar, no leídos de la ficha al mostrarlos.
  nombre      text not null,
  rut         text,

  imagen      text not null,
  -- SHA-256 del texto que se firmó. Si algún día no calza con el del
  -- documento, la pantalla lo dice en vez de mostrar como firmado algo que ya
  -- no es lo que se firmó.
  cuerpo_hash text not null,

  -- La hora del servidor, nunca la del teléfono: la del aparato la cambia
  -- cualquiera en Ajustes, y una firma que no se puede fechar no sirve de
  -- respaldo. Mismo criterio que el libro de asistencia.
  firmado_en  timestamptz not null default now(),

  quien       text,
  -- SHA-256 de la IP con SESION_SECRETO de sal, no la IP. Acá no se borra a
  -- los dos días como en los contactos de la web: allá sirve para contar
  -- envíos y después estorba, acá es parte de reconstruir el acto.
  ip_huella   text,
  agente      text,

  -- Una firma no se repite ni se corrige: si estaba mal, se anula el
  -- documento y se hace otro. Dejar reescribir una firma sería dejar
  -- reescribir la prueba.
  constraint firma_acceso_una_por_rol unique (entidad, entidad_id, rol)
);

create index if not exists idx_firma_acc_entidad on firmas_acceso(entidad, entidad_id);

comment on table firmas_acceso is
  'Firmas con el dedo de los certificados de cambio de turno y de los informes de evento. Firma electrónica simple de la Ley 19.799.';

-- ======================================================= 6. la retención
--
-- Le borra a los accesos viejos lo que identifica a una persona y deja el
-- hecho. Después de pasar por acá, la fila sigue diciendo que el 14 de marzo
-- a las 09:14 entró alguien en camioneta a Puelche y salió a las 11:02, y deja
-- de decir quién era.
--
-- Por qué una función y no un `delete`: el registro de que hubo movimiento ese
-- día es de la empresa y sirve para contar; el RUN del visitante no es de la
-- empresa y deja de tener motivo cuando pasa el plazo. Borrar la fila entera
-- perdería lo primero para proteger lo segundo.
--
-- Qué se borra, que es más de lo que se nombra en la decisión: el RUN y el
-- nombre, y además la patente, el número de serie de la cédula, a quién venía
-- a ver y la nota libre. La patente lleva a una persona por el Registro Civil,
-- y la nota libre es donde el guardia escribe cualquier cosa, incluido un
-- nombre.
--
-- `dias` es un parámetro y no una constante escrita adentro para que el día
-- que el gerente cambie de opinión —o que un mandante exija dos años— el
-- cambio sea una línea en el Worker y no otra migración.
--
-- Qué NO toca, a propósito: las novedades, los certificados y los eventos. Eso
-- no son datos de visitantes, es el trabajo escrito de la empresa y de sus
-- trabajadores; un informe de evento es, encima, un documento firmado que
-- puede terminar en un tribunal, y vaciarlo a los doce meses sería destruir
-- justamente la prueba que se construyó.
create or replace function anonimizar_accesos(dias integer default 365)
returns integer
language plpgsql
as $$
declare
  cuantos integer;
begin
  update accesos
     set run              = null,
         nombre           = null,
         a_quien_visita   = null,
         patente          = null,
         documento_serie  = null,
         documento_vence  = null,
         nota             = null,
         anonimizado_en   = now()
   where anonimizado_en is null
     and entrada_en < now() - make_interval(days => dias);
  get diagnostics cuantos = row_count;
  return cuantos;
end;
$$;

comment on function anonimizar_accesos(integer) is
  'Le borra a los accesos de más de `dias` lo que identifica a una persona y deja el hecho. Devuelve cuántas filas tocó. Se puede correr las veces que sea.';

-- ============================================================= 7. las vistas
--
-- Van con drop y create y no con `create or replace`: si mañana una migración
-- les agrega una columna, reaplicar ésta fallaría con «cannot drop columns
-- from view» y dejaría la pasada a medias. Ya pasó con v_documentos.
drop view if exists v_accesos;
create view v_accesos as
select a.*,
       i.nombre as instalacion,
       (a.salida_en is null) as adentro,
       case when a.salida_en is null then null
            else round(extract(epoch from (a.salida_en - a.entrada_en)) / 3600.0, 2)
       end as horas
  from accesos a
  left join instalaciones i on i.id = a.instalacion_id;

comment on view v_accesos is
  'Accesos con el nombre de la instalación, si siguen adentro y cuántas horas estuvieron.';

drop view if exists v_novedades;
create view v_novedades as
select n.*,
       i.nombre as instalacion,
       (select count(*) from novedades c where c.corrige_id = n.id) as correcciones
  from novedades n
  left join instalaciones i on i.id = n.instalacion_id;

comment on view v_novedades is
  'Novedades con el nombre de la instalación y cuántas correcciones tiene cada una.';

drop view if exists v_cambios_turno;
create view v_cambios_turno as
select c.*,
       (select count(*) from firmas_acceso f
         where f.entidad = 'cambio_turno' and f.entidad_id = c.id) as firmas,
       (select count(*) from firmas_acceso f
         where f.entidad = 'cambio_turno' and f.entidad_id = c.id
           and f.cuerpo_hash <> c.cuerpo_hash) as firmas_descuadradas
  from cambios_turno c;

comment on view v_cambios_turno is
  'Certificados de cambio de turno. No trae las imágenes de las firmas: ésas se piden de a una.';

drop view if exists v_eventos;
create view v_eventos as
select e.*,
       (select count(*) from firmas_acceso f
         where f.entidad = 'evento' and f.entidad_id = e.id) as firmas,
       (select count(*) from firmas_acceso f
         where f.entidad = 'evento' and f.entidad_id = e.id
           and f.cuerpo_hash <> e.cuerpo_hash) as firmas_descuadradas
  from eventos_especiales e;

comment on view v_eventos is
  'Informes de evento especial. No trae las imágenes de las firmas.';

-- ========================================================= 8. el candado
--
-- Mismo candado que el resto del sistema: las tablas quedan cerradas con RLS y
-- sin políticas, así que no entra nadie salvo el Worker con la clave de
-- servicio. El control de quién ve qué está en el Worker, no en la base.
alter table accesos            enable row level security;
alter table novedades          enable row level security;
alter table cambios_turno      enable row level security;
alter table eventos_especiales enable row level security;
alter table firmas_acceso      enable row level security;

do $$
declare
  t text;
  r text;
  tablas text[] := array['accesos', 'novedades', 'cambios_turno',
                         'eventos_especiales', 'firmas_acceso'];
begin
  foreach t in array tablas loop
    foreach r in array array['anon', 'authenticated'] loop
      if exists (select 1 from pg_roles where rolname = r) then
        execute format('revoke all on %I from %I', t, r);
      end if;
    end loop;
    if exists (select 1 from pg_roles where rolname = 'service_role') then
      execute format('grant all on %I to service_role', t);
    end if;
  end loop;

  -- Las vistas salen con los permisos del que las creó; se cierran igual.
  foreach t in array array['v_accesos', 'v_novedades', 'v_cambios_turno', 'v_eventos'] loop
    foreach r in array array['anon', 'authenticated'] loop
      if exists (select 1 from pg_roles where rolname = r) then
        execute format('revoke all on %I from %I', t, r);
      end if;
    end loop;
    if exists (select 1 from pg_roles where rolname = 'service_role') then
      execute format('grant all on %I to service_role', t);
    end if;
  end loop;

  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function anonimizar_accesos(integer) to service_role;
  end if;
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke execute on function anonimizar_accesos(integer) from %I', r);
    end if;
  end loop;
end $$;

-- ============================================================== resultado
--
-- Lo que sale acá es lo que hay que mirar después de pegarla: cinco tablas y
-- cuatro vistas. Si alguna dice 0 filas no pasa nada —están recién creadas—;
-- lo que importa es que la consulta corra sin error.
select 'control de acceso listo'            as resultado,
       (select count(*) from accesos)            as accesos,
       (select count(*) from novedades)          as novedades,
       (select count(*) from cambios_turno)      as cambios_turno,
       (select count(*) from eventos_especiales) as eventos,
       (select count(*) from firmas_acceso)      as firmas,
       (select count(*) from v_accesos)          as vista_accesos;
