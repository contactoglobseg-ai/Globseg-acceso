-- =============================================================================
-- Novedades con foto y con la precisión del GPS (acceso.seggarridos.com)
--
-- Se pega a mano en el SQL Editor de Supabase, como las demás (ver README).
-- Mientras no se aplique, el libro de novedades funciona igual que antes: la
-- novedad se guarda sin foto y la pantalla lo avisa. Nada se rompe.
--
-- Solo AGREGA: tres columnas nuevas en `novedades` (vacías en las filas que ya
-- existen), la vista `v_novedades` rehecha para que las muestre, y una carpeta
-- privada para las fotos. No cambia ni borra ninguna fila.
-- =============================================================================

-- 1. Las columnas ---------------------------------------------------------
-- `exactitud_m`: el radio en metros que el teléfono informa junto con las
-- coordenadas. Una ubicación con ±15 m y otra con ±1.300 m no valen lo mismo
-- como prueba de que alguien estaba en el puesto, y sin este número no se
-- distinguen.
alter table novedades add column if not exists exactitud_m integer
  check (exactitud_m is null or exactitud_m >= 0);

-- La foto vive en la carpeta `fotos-novedades`; acá queda solo la ruta.
alter table novedades add column if not exists foto_ruta  text;
alter table novedades add column if not exists foto_bytes integer;

-- 2. La vista -------------------------------------------------------------
-- `select n.*` se expande cuando se crea la vista, no cuando se consulta: sin
-- rehacerla, las columnas nuevas no aparecerían. Es la misma definición de la
-- migración 20261023120000_control_acceso.sql.
drop view if exists v_novedades;
create view v_novedades as
select n.*,
       i.nombre as instalacion,
       (select count(*) from novedades c where c.corrige_id = n.id) as correcciones
  from novedades n
  left join instalaciones i on i.id = n.instalacion_id;

comment on view v_novedades is
  'Novedades con el nombre de la instalación y cuántas correcciones tiene cada una.';

-- El mismo candado que el resto: cerrada para todos salvo el Worker.
do $$
declare r text;
begin
  foreach r in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on v_novedades from %I', r);
    end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant all on v_novedades to service_role;
  end if;
end $$;

-- 3. La carpeta de fotos (privada) ----------------------------------------
-- Máximo 2 MB por foto y solo JPEG; la app las manda de unos 100 KB.
-- Sin políticas en storage.objects: solo el Worker (clave de servicio) sube y lee.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('fotos-novedades', 'fotos-novedades', false, 2097152, array['image/jpeg'])
on conflict (id) do nothing;

-- Resultado ---------------------------------------------------------------
select 'novedades con foto listas' as resultado,
       (select count(*) from novedades) as novedades,
       (select count(*) from storage.buckets where id = 'fotos-novedades') as carpeta;
