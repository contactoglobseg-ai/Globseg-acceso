-- =============================================================================
-- Cambio de vehículo (acceso.seggarridos.com, pestaña «Vehículo»)
--
-- Cuando un guardia le pasa la camioneta a otro queda un acta, igual que el
-- cambio de turno: quién la entrega, quién la recibe, la patente, y si tiene
-- algún daño, qué daño y sus fotos. La firman los dos con el dedo.
--
-- Solo AGREGA: dos tablas nuevas, una vista, y permite que `firmas_acceso`
-- guarde también las firmas de este tipo de acta. No cambia ni borra ninguna
-- fila de lo que ya existe. Las fotos van a la misma carpeta privada de las
-- novedades (`fotos-novedades`), dentro de `vehiculos/`.
-- =============================================================================

-- 1. El acta -----------------------------------------------------------------
create table if not exists cambios_vehiculo (
  id                   bigint generated always as identity primary key,
  numero               text not null unique,              -- CV-2026-0001
  instalacion_id       bigint references instalaciones(id) on delete set null,
  instalacion_nombre   text not null,

  cuando               timestamptz not null default now(),
  fecha                date not null,

  -- La patente, siempre en el mismo formato (mayúsculas, sin guiones ni
  -- espacios), para que el historial de cada camioneta quede junto.
  patente              text not null check (patente ~ '^[A-Z0-9]{4,8}$'),

  -- Los dos, congelados como en el cambio de turno.
  entrega_trabajador_id bigint references trabajadores(id) on delete set null,
  entrega_nombre       text not null,
  entrega_rut          text,
  recibe_trabajador_id bigint references trabajadores(id) on delete set null,
  recibe_nombre        text not null,
  recibe_rut           text,

  con_danos            boolean not null default false,
  danos                text,

  cuerpo               text not null,
  cuerpo_hash          text not null,

  estado               text not null default 'pendiente'
                       check (estado in ('pendiente', 'firmado', 'anulado')),
  anulado_motivo       text,
  creado_por           text,
  creado_en            timestamptz not null default now(),

  constraint cv_danos_con_texto check (not con_danos or coalesce(trim(danos), '') <> '')
);

create index if not exists idx_cv_inst_fecha on cambios_vehiculo(instalacion_id, fecha desc);
create index if not exists idx_cv_patente    on cambios_vehiculo(patente, cuando desc);
create index if not exists idx_cv_fecha      on cambios_vehiculo(fecha desc);

comment on table cambios_vehiculo is
  'Acta de cambio de vehículo entre guardias. El cuerpo se congela al crearla; la firman con el dedo quien entrega y quien recibe.';

-- 2. Las fotos de los daños ----------------------------------------------------
-- Solo se sacan si hay daño. El SHA-256 de cada foto va impreso dentro del
-- acta, así que la firma también cubre las fotos: cambiar una después se nota.
create table if not exists fotos_vehiculo (
  id            bigint generated always as identity primary key,
  cambio_id     bigint not null references cambios_vehiculo(id) on delete cascade,
  orden         smallint not null,
  ruta          text not null,
  bytes         integer,
  sha256        text not null,
  lat           double precision,
  lon           double precision,
  exactitud_m   integer check (exactitud_m is null or exactitud_m >= 0),
  creado_en     timestamptz not null default now(),
  unique (cambio_id, orden)
);

create index if not exists idx_fv_cambio on fotos_vehiculo(cambio_id);

comment on table fotos_vehiculo is
  'Fotos de los daños de un cambio de vehículo. El archivo vive en la carpeta fotos-novedades, bajo vehiculos/.';

-- 3. Las firmas ----------------------------------------------------------------
-- La tabla de firmas solo aceptaba cambio de turno y evento. Se le suma este.
alter table firmas_acceso drop constraint if exists firmas_acceso_entidad_check;
alter table firmas_acceso add constraint firmas_acceso_entidad_check
  check (entidad in ('cambio_turno', 'evento', 'cambio_vehiculo'));

-- 4. La vista ------------------------------------------------------------------
drop view if exists v_cambios_vehiculo;
create view v_cambios_vehiculo as
select c.*,
       (select count(*) from firmas_acceso f
         where f.entidad = 'cambio_vehiculo' and f.entidad_id = c.id) as firmas,
       (select count(*) from firmas_acceso f
         where f.entidad = 'cambio_vehiculo' and f.entidad_id = c.id
           and f.cuerpo_hash <> c.cuerpo_hash) as firmas_descuadradas,
       (select count(*) from fotos_vehiculo v where v.cambio_id = c.id) as fotos
  from cambios_vehiculo c;

comment on view v_cambios_vehiculo is
  'Cambios de vehículo con cuántas firmas y fotos tiene cada uno. No trae las imágenes.';

-- 5. El candado ----------------------------------------------------------------
-- Igual que el resto: cerradas para todos salvo el Worker con la clave de servicio.
alter table cambios_vehiculo enable row level security;
alter table fotos_vehiculo   enable row level security;
