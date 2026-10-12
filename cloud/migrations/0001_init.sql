-- Pulseiras (um paciente = uma pulseira). O token do dispositivo só é guardado como hash.
CREATE TABLE devices (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  patient_ref  TEXT,                         -- identificador externo (prontuário, CPF hash etc.)
  notes        TEXT,
  metadata     TEXT NOT NULL DEFAULT '{}',   -- JSON livre para integrações
  token_hash   TEXT NOT NULL UNIQUE,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  last_seen_at INTEGER,
  online       INTEGER NOT NULL DEFAULT 0,
  band_info    TEXT,                         -- JSON: nome, MAC, firmware, hardware, serial
  client_info  TEXT,                         -- JSON: versão do app, modelo do celular
  archived_at  INTEGER
);
CREATE INDEX idx_devices_patient_ref ON devices(patient_ref);

-- Chaves de API para integrações. device_ids (JSON) restringe a chave a certas pulseiras.
CREATE TABLE api_keys (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  key_hash     TEXT NOT NULL UNIQUE,
  scopes       TEXT NOT NULL,                -- JSON: ["read","command","manage","admin"]
  device_ids   TEXT,                         -- JSON ou NULL (= todas)
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at   INTEGER
);

CREATE TABLE heart_rate (
  device_id TEXT NOT NULL,
  ts        INTEGER NOT NULL,
  bpm       INTEGER NOT NULL,
  PRIMARY KEY (device_id, ts)
) WITHOUT ROWID;

CREATE TABLE steps (
  device_id TEXT NOT NULL,
  ts        INTEGER NOT NULL,
  steps     INTEGER NOT NULL,
  meters    INTEGER,
  calories  INTEGER,
  PRIMARY KEY (device_id, ts)
) WITHOUT ROWID;

CREATE TABLE battery (
  device_id TEXT NOT NULL,
  ts        INTEGER NOT NULL,
  level     INTEGER NOT NULL,
  charging  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (device_id, ts)
) WITHOUT ROWID;

-- Eventos da pulseira (botão, meta de passos, retirada do pulso, adormeceu...) e do sistema.
CREATE TABLE events (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id TEXT NOT NULL,
  ts        INTEGER NOT NULL,
  type      TEXT NOT NULL,
  data      TEXT
);
CREATE INDEX idx_events_device_ts ON events(device_id, ts);
CREATE INDEX idx_events_type ON events(device_id, type, ts);

-- Histórico baixado da memória da pulseira: 1 amostra por minuto (sono/atividade).
CREATE TABLE activity (
  device_id TEXT NOT NULL,
  ts        INTEGER NOT NULL,                -- início do minuto, ms
  kind      INTEGER NOT NULL,                -- categoria bruta da pulseira
  intensity INTEGER NOT NULL,
  steps     INTEGER NOT NULL,
  hr        INTEGER,
  PRIMARY KEY (device_id, ts)
) WITHOUT ROWID;

-- Comandos para a pulseira: queued -> sent -> acked | failed | timeout | expired | cancelled
CREATE TABLE commands (
  id         TEXT PRIMARY KEY,
  device_id  TEXT NOT NULL,
  type       TEXT NOT NULL,
  params     TEXT NOT NULL DEFAULT '{}',
  status     TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  sent_at    INTEGER,
  acked_at   INTEGER,
  result     TEXT,
  error      TEXT,
  created_by TEXT
);
CREATE INDEX idx_commands_device ON commands(device_id, created_at);
CREATE INDEX idx_commands_pending ON commands(device_id, status);

CREATE TABLE alert_rules (
  id         TEXT PRIMARY KEY,
  device_id  TEXT,                           -- NULL = vale para todas as pulseiras
  name       TEXT NOT NULL,
  metric     TEXT NOT NULL,                  -- heart_rate | battery | offline | event
  op         TEXT NOT NULL,                  -- gt | gte | lt | lte | eq
  threshold  REAL,
  match      TEXT,                           -- tipo do evento (metric = event)
  duration_s INTEGER NOT NULL DEFAULT 0,     -- condição precisa durar tanto tempo
  cooldown_s INTEGER NOT NULL DEFAULT 300,
  severity   TEXT NOT NULL DEFAULT 'warning',
  action     TEXT NOT NULL DEFAULT '{}',     -- JSON: {"vibrate":{...},"message":{...}}
  enabled    INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

CREATE TABLE alerts (
  id         TEXT PRIMARY KEY,
  device_id  TEXT NOT NULL,
  rule_id    TEXT,
  ts         INTEGER NOT NULL,
  metric     TEXT NOT NULL,
  value      REAL,
  severity   TEXT NOT NULL,
  message    TEXT NOT NULL,
  acked_at   INTEGER,
  acked_by   TEXT
);
CREATE INDEX idx_alerts_device_ts ON alerts(device_id, ts);
CREATE INDEX idx_alerts_ts ON alerts(ts);

CREATE TABLE webhooks (
  id              TEXT PRIMARY KEY,
  url             TEXT NOT NULL,
  secret          TEXT NOT NULL,
  events          TEXT NOT NULL,             -- JSON: ["alert.created","device.online",...] ou ["*"]
  device_id       TEXT,
  enabled         INTEGER NOT NULL DEFAULT 1,
  created_at      INTEGER NOT NULL,
  last_attempt_at INTEGER,
  last_status     INTEGER,
  failures        INTEGER NOT NULL DEFAULT 0
);
