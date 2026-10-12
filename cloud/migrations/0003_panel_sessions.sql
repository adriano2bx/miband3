-- Sessões individuais do painel web. A autorização de leitura continua vinculada
-- ao escopo panel_read do técnico e expira por inatividade ou por limite absoluto.
CREATE TABLE panel_sessions (
  id             TEXT PRIMARY KEY,
  token_hash     TEXT NOT NULL UNIQUE,
  technician_id  TEXT NOT NULL,
  created_at     INTEGER NOT NULL,
  expires_at     INTEGER NOT NULL,
  max_expires_at INTEGER NOT NULL,
  revoked_at     INTEGER
);
CREATE INDEX idx_panel_sessions_technician ON panel_sessions(technician_id, revoked_at);
