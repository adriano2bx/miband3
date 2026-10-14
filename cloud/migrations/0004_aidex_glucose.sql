-- Módulo AiDEX (glicemia): integração somente-leitura com a AiDEX API Open Platform
-- (OAuth 2.0). Um vínculo por pulseira/paciente: o paciente autoriza o app BIOSENSE
-- na tela oficial da AiDEX e pode revogar a qualquer momento no app AiDEX.
--
-- Observação de segurança: diferente do token da pulseira (guardado só como hash),
-- os tokens OAuth precisam ficar em claro para serem reapresentados à API AiDEX.
-- São segredos em repouso na D1; o acesso à D1 é a fronteira de confiança.
CREATE TABLE aidex_links (
  device_id     TEXT PRIMARY KEY REFERENCES devices(id),
  env           TEXT NOT NULL DEFAULT 'sandbox',  -- sandbox | production
  status        TEXT NOT NULL DEFAULT 'pending',  -- pending | linked | revoked | error
  state         TEXT,                             -- nonce anti-CSRF durante a autorização
  access_token  TEXT,
  refresh_token TEXT,
  expires_at    INTEGER,                          -- epoch ms de expiração do access_token
  cursor_at     INTEGER,                          -- epoch ms: até onde a glicemia já foi coletada
  last_poll_at  INTEGER,
  last_error    TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

-- Leituras de glicose do sensor. Unidade nativa da API é mmol/L (valor float).
-- Mesma forma de heart_rate: chave (device_id, ts), ts em epoch ms (deviceTime em UTC).
CREATE TABLE glucose (
  device_id TEXT NOT NULL,
  ts        INTEGER NOT NULL,
  mmol      REAL NOT NULL,
  warning   TEXT,            -- 'high glucose alert' | 'low glucose alert' | 'urgent low glucose alert' | NULL
  PRIMARY KEY (device_id, ts)
) WITHOUT ROWID;

-- Eventos registrados pelo usuário na AiDEX (refeição, exercício, medicação, insulina, outros).
-- Dedup pelo id do próprio registro na API (ext_id).
CREATE TABLE glucose_events (
  device_id TEXT NOT NULL,
  type      TEXT NOT NULL,   -- diet | exercise | medication | insulin | other
  ext_id    TEXT NOT NULL,   -- id do registro na AiDEX
  ts        INTEGER NOT NULL,-- epoch ms do evento
  payload   TEXT NOT NULL,   -- JSON original do item
  PRIMARY KEY (device_id, type, ext_id)
) WITHOUT ROWID;
CREATE INDEX idx_glucose_events_ts ON glucose_events(device_id, ts);
