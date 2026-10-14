-- Paciente como entidade de 1ª classe (camada pessoal/clínica do modelo híbrido).
-- Um paciente pode ter vários devices: a pulseira Mi Band (type 'miband') e/ou o
-- sensor de glicemia AiDEX (type 'cgm'). O patient_ref de texto livre continua
-- existindo para compatibilidade, mas patient_id (FK) passa a ser a ligação robusta
-- usada na consolidação do painel e no escopo de acesso (owner/follower).
CREATE TABLE patients (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  ref         TEXT,                         -- identificador externo (prontuário, código do estudo)
  notes       TEXT,
  metadata    TEXT NOT NULL DEFAULT '{}',
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  archived_at INTEGER
);
CREATE INDEX idx_patients_ref ON patients(ref);

ALTER TABLE devices ADD COLUMN patient_id TEXT REFERENCES patients(id);
CREATE INDEX idx_devices_patient_id ON devices(patient_id);

-- Backfill: cria um paciente por patient_ref distinto (não arquivado) e liga os devices.
INSERT INTO patients (id, name, ref, created_at, updated_at)
SELECT 'pat_' || lower(hex(randomblob(10))), patient_ref, patient_ref,
       (strftime('%s','now') * 1000), (strftime('%s','now') * 1000)
FROM (SELECT DISTINCT patient_ref FROM devices
      WHERE patient_ref IS NOT NULL AND TRIM(patient_ref) <> '' AND archived_at IS NULL);

UPDATE devices SET patient_id = (SELECT p.id FROM patients p WHERE p.ref = devices.patient_ref)
WHERE patient_ref IS NOT NULL AND TRIM(patient_ref) <> '' AND archived_at IS NULL;
