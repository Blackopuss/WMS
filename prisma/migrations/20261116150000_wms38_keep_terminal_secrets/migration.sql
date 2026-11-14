-- WMS-38 (ADR 0061 §1): los secretos de una terminal activa nunca se borran.
-- Borrar los viejos podía dejar viva solo a una copia (la terminal real
-- volvía con un secreto que ya «nunca se emitió») y rompía la regla de que
-- una respuesta perdida no importa, pase el tiempo que pase. Solo se borran
-- los de una terminal ya quitada.
DROP TRIGGER `shared_terminal_secret_cleanup_only`;

CREATE TRIGGER `shared_terminal_secret_removed_only` BEFORE DELETE ON `shared_terminal_secret` FOR EACH ROW
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM `shared_terminal`
        WHERE `id` = OLD.`terminalId` AND `removedAt` IS NOT NULL
    ) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'shared_terminal_secret: secrets of an active terminal are never deleted';
    END IF;
END;
