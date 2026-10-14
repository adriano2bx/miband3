-- Consentimento do voluntário para cada seguidor: quem concedeu e a nota de
-- autorização (ex.: "autorizado pelo voluntário em DD/MM"). Fica no vínculo N:N.
ALTER TABLE technician_patients ADD COLUMN granted_by TEXT;
ALTER TABLE technician_patients ADD COLUMN consent_note TEXT;
