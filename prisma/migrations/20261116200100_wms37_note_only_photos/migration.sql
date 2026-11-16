-- WMS-37 (ADR 0063): a follow-up note of an incident can be only photos,
-- so its text may be empty (exactly ''); the service demands words when it
-- brings no photos. Spaces alone are still refused.
ALTER TABLE `incident_note` DROP CHECK `incident_note_text_check`;
ALTER TABLE `incident_note` ADD CONSTRAINT `incident_note_text_check` CHECK (
    CHAR_LENGTH(TRIM(`text`)) > 0 OR `text` = ''
);
