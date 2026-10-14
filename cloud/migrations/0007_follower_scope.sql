-- Acesso por paciente (camada pessoal). Um "seguidor" é uma conta de painel
-- só-leitura amarrada a um paciente: reaproveita a tabela technicians com o
-- escopo 'panel_read' e um patient_id. patient_id NULL = conta ampla (staff/gestão,
-- comportamento atual). Com patient_id, a sessão de painel só enxerga os devices
-- daquele paciente.
ALTER TABLE technicians ADD COLUMN patient_id TEXT REFERENCES patients(id);
CREATE INDEX idx_technicians_patient_id ON technicians(patient_id);
