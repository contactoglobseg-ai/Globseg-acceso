-- =============================================================================
-- Categoría «Sin complejidades» en el libro de novedades
--
-- Es la foto de control del turno cuando no hay nada que contar ("turno
-- realizado sin complejidades que informar"). Solo amplía la lista de
-- categorías permitidas: no cambia ninguna fila.
-- =============================================================================
alter table novedades drop constraint if exists novedades_categoria_check;
alter table novedades add constraint novedades_categoria_check
  check (categoria in ('novedad', 'ronda', 'incidencia', 'entrega_turno', 'otro',
                       'sin_complejidades'));
