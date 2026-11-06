-- Независимое наблюдение за входящими сообщениями amoCRM. Сделки не изменяет.
CREATE TABLE IF NOT EXISTS amo_watch_rules (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, match_text TEXT NOT NULL,
  pipeline_id INTEGER, status_id INTEGER, expected_tags TEXT NOT NULL DEFAULT '[]',
  source_field_id INTEGER NOT NULL DEFAULT 1439087, source_enum_id INTEGER,
  source_value TEXT NOT NULL DEFAULT '', enabled INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS amo_watch_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, account_id INTEGER NOT NULL,
  message_id TEXT NOT NULL, created_at INTEGER NOT NULL, received_at INTEGER NOT NULL,
  contact_id INTEGER, talk_id INTEGER, chat_id TEXT NOT NULL DEFAULT '',
  origin TEXT NOT NULL DEFAULT '', message_type TEXT NOT NULL DEFAULT '',
  message_text TEXT NOT NULL DEFAULT '', text_truncated INTEGER NOT NULL DEFAULT 0,
  rules_json TEXT NOT NULL, matched_rules TEXT NOT NULL DEFAULT '', lead_id INTEGER, initial_json TEXT,
  phase INTEGER NOT NULL DEFAULT 0, next_check_at INTEGER, lease_until INTEGER NOT NULL DEFAULT 0,
  failures INTEGER NOT NULL DEFAULT 0, result TEXT NOT NULL DEFAULT 'pending',
  detail TEXT NOT NULL DEFAULT '', latest_json TEXT, updated_at INTEGER NOT NULL,
  UNIQUE(account_id, message_id)
);
CREATE INDEX IF NOT EXISTS amo_watch_due ON amo_watch_events(next_check_at, lease_until);
CREATE INDEX IF NOT EXISTS amo_watch_lead ON amo_watch_events(lead_id, id);
CREATE INDEX IF NOT EXISTS amo_watch_received ON amo_watch_events(received_at, id);
CREATE TABLE IF NOT EXISTS amo_watch_checks (
  id INTEGER PRIMARY KEY AUTOINCREMENT, event_id INTEGER NOT NULL REFERENCES amo_watch_events(id) ON DELETE CASCADE,
  phase INTEGER NOT NULL, checked_at INTEGER NOT NULL, result TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '', snapshot_json TEXT, results_json TEXT NOT NULL DEFAULT '[]',
  UNIQUE(event_id, phase)
);
CREATE TABLE IF NOT EXISTS amo_watch_health (id TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);
-- Копия известного блока F5 №131. Точный текст сохраняется, без нормализации.
INSERT OR IGNORE INTO amo_watch_rules
  (id,name,match_text,pipeline_id,status_id,expected_tags,source_enum_id,source_value,updated_at)
VALUES ('f5-131','Ильнара · блок F5 №131','Я от Ильнары, тренинг Команда',8733326,70705174,'["13.10_Ильнара"]',1223105,'Интеграции',unixepoch());
