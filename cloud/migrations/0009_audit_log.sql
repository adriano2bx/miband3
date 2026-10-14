-- Trilha de auditoria de acesso a dados de saúde (LGPD/clínico): quem acessou os
-- dados de qual voluntário, logins e mudanças de acesso.
CREATE TABLE audit_log (
  id         TEXT PRIMARY KEY,
  ts         INTEGER NOT NULL,
  principal  TEXT NOT NULL,          -- admin | tech:<id> | key:<id>
  action     TEXT NOT NULL,          -- patient.view | alert.ack | follower.grant | ...
  patient_id TEXT,
  device_id  TEXT,
  detail     TEXT
);
CREATE INDEX idx_audit_ts ON audit_log(ts);
CREATE INDEX idx_audit_patient ON audit_log(patient_id);
