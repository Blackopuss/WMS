-- WMS-68 review: known devices are read by the unique (userId, dedupeKey)
-- index; the (userId, deviceKey) index of the previous migration is unused.
-- DropIndex
DROP INDEX `security_event_userId_deviceKey_idx` ON `security_event`;

