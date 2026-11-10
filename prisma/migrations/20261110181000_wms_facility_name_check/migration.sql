-- WMS-18: el nombre vacío ya lo rechaza facility_name_check (INV-13); se quita
-- la regla repetida que agregó la migración anterior.
ALTER TABLE `facility` DROP CHECK `facility_name`;
