-- Одноразовый вход через Telegram. Секреты ссылок и браузера хранятся как SHA-256.
CREATE TABLE IF NOT EXISTS tg_login_codes (
  code TEXT PRIMARY KEY, browser TEXT NOT NULL, go_key TEXT UNIQUE,
  tg_id INTEGER, state TEXT NOT NULL DEFAULT 'wait', expires TEXT NOT NULL,
  return_to TEXT NOT NULL DEFAULT '/'
);
CREATE INDEX IF NOT EXISTS tg_login_expiry ON tg_login_codes(expires);
