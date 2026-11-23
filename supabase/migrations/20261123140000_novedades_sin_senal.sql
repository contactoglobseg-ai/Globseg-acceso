-- =============================================================================
-- Novedades escritas sin señal (cola en el teléfono)
--
-- En un parque sin señal la novedad queda guardada en el teléfono y se envía
-- cuando vuelve la conexión. Para que eso no rompa las reglas del libro:
--
--   · `uid`: el teléfono le pone un código a cada novedad una sola vez. Si el
--     envío se corta y se reintenta, el servidor reconoce el código y no la
--     escribe dos veces.
--   · `escrita_en`: la hora del teléfono cuando el guardia la escribió. La de
--     `cuando` sigue siendo la del servidor, que el teléfono no puede tocar.
--     Las dos quedan, y la revisión marca las que llegaron con atraso.
--
-- Solo agrega dos columnas (vacías en las filas que ya existen) y rehace la
-- vista para que las muestre. No cambia ninguna fila.
-- =============================================================================
alter table novedades add column if not exists uid        uuid unique;
alter table novedades add column if not exists escrita_en timestamptz;

-- `select n.*` se expande al crear la vista: hay que rehacerla.
drop view if exists v_novedades;
create view v_novedades as
select n.*,
       i.nombre as instalacion,
       (select count(*) from novedades c where c.corrige_id = n.id) as correcciones
  from novedades n
  left join instalaciones i on i.id = n.instalacion_id;

comment on view v_novedades is
  'Novedades con el nombre de la instalación y cuántas correcciones tiene cada una.';

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
