-- Предложения пингов (15.10.2026): бот не пишет клиенту сам — предлагает менеджеру текст и сценарий кружочка по договорённости из разбора встречи.
CREATE TABLE IF NOT EXISTS ping_suggest (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  deal INTEGER NOT NULL,
  manager TEXT NOT NULL DEFAULT '',
  client TEXT NOT NULL DEFAULT '',
  company TEXT NOT NULL DEFAULT '',
  due_day TEXT NOT NULL,              -- когда предложить (YYYY-MM-DD, МСК)
  reason TEXT NOT NULL DEFAULT '',    -- повод: договорённость из разбора
  loyalty INTEGER,
  text TEXT NOT NULL DEFAULT '',      -- вариант 1: сообщение
  script TEXT NOT NULL DEFAULT '',    -- вариант 2: что сказать в кружочке
  status TEXT NOT NULL DEFAULT 'new', -- new / text / video / skip
  decided_by TEXT NOT NULL DEFAULT '',
  decided_at TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ping_suggest_due ON ping_suggest (due_day);

ALTER TABLE ping_suggest ADD COLUMN notified_at TEXT NOT NULL DEFAULT '';  -- когда ушло уведомление в Telegram
