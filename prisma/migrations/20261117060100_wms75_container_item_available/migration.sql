-- WMS-75 (ADR 0072), revisión: lo que una tarima o un bulto agrupa es
-- siempre existencia disponible (`putIn` de containers.ts es lo único que
-- escribe aquí, y escribe AVAILABLE). Con un estado más no disponible, la
-- base lo exige también. Solo expansión: todas las filas existentes son
-- AVAILABLE.
ALTER TABLE `container_item`
  ADD CONSTRAINT `container_item_available` CHECK (`status` = 'AVAILABLE');
