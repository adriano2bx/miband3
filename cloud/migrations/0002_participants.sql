-- Adesão de participantes (BIOSENSE): instalação autorizada, consentimento versionado,
-- perfil de coleta definido na nuvem e acesso técnico com sessão.

-- pending = instalação feita pelo app, aguardando a equipe vincular o participante
-- active  = autorizada (aceita telemetria se houver consentimento válido)
-- revoked = bloqueada (o app mostra "Conexão não autorizada")
ALTER TABLE devices ADD COLUMN status TEXT NOT NULL DEFAULT 'active';
ALTER TABLE devices ADD COLUMN consent_version TEXT;
ALTER TABLE devices ADD COLUMN consent_at INTEGER;
ALTER TABLE devices ADD COLUMN config TEXT NOT NULL DEFAULT '{}';
ALTER TABLE devices ADD COLUMN config_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE devices ADD COLUMN config_updated_at INTEGER;

-- Identificador gerado pelo app para não gravar o mesmo evento duas vezes em reenvios.
ALTER TABLE events ADD COLUMN client_id TEXT;
CREATE UNIQUE INDEX idx_events_client ON events(device_id, client_id) WHERE client_id IS NOT NULL;

-- Termo de participação publicado pela equipe responsável (conteúdo real, versionado).
CREATE TABLE consent_terms (
  version            TEXT PRIMARY KEY,
  title              TEXT NOT NULL,
  content            TEXT NOT NULL,
  requires_reconsent INTEGER NOT NULL DEFAULT 1,
  published_at       INTEGER NOT NULL
);

-- Cada aceite ou recusa registrado pelo servidor.
CREATE TABLE consent_records (
  id         TEXT PRIMARY KEY,
  device_id  TEXT NOT NULL,
  version    TEXT NOT NULL,
  accepted   INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  client     TEXT
);
CREATE INDEX idx_consent_device ON consent_records(device_id, created_at);

CREATE TABLE technicians (
  id              TEXT PRIMARY KEY,
  credential      TEXT NOT NULL UNIQUE,
  name            TEXT NOT NULL,
  password_hash   TEXT NOT NULL,
  scopes          TEXT NOT NULL,             -- JSON: ["tech"] ou ["tech","provision"]
  created_at      INTEGER NOT NULL,
  disabled_at     INTEGER,
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until    INTEGER
);

CREATE TABLE tech_sessions (
  id            TEXT PRIMARY KEY,
  token_hash    TEXT NOT NULL UNIQUE,
  technician_id TEXT NOT NULL,
  device_id     TEXT,                        -- instalação em que o técnico entrou
  scopes        TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,            -- renovado a cada uso (inatividade)
  max_expires_at INTEGER NOT NULL,           -- limite absoluto
  revoked_at    INTEGER
);
