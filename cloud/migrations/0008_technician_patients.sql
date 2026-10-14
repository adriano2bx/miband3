-- Acesso N:N: um técnico (responsável) pode ter vários voluntários (pacientes)
-- atrelados; um seguidor tem exatamente um. A conta de painel passa a enxergar
-- os devices de TODOS os seus pacientes. Sem nenhum paciente atrelado = conta ampla
-- (gestão/staff), comportamento atual.
CREATE TABLE technician_patients (
  technician_id TEXT NOT NULL REFERENCES technicians(id),
  patient_id    TEXT NOT NULL REFERENCES patients(id),
  created_at    INTEGER NOT NULL,
  PRIMARY KEY (technician_id, patient_id)
);
CREATE INDEX idx_tech_patients_patient ON technician_patients(patient_id);

-- Migra o patient_id (singular) da 0007 para o modelo N:N.
INSERT OR IGNORE INTO technician_patients (technician_id, patient_id, created_at)
SELECT id, patient_id, (strftime('%s','now') * 1000) FROM technicians WHERE patient_id IS NOT NULL;
