-- Разбор диагностики после встречи (раздел «Подготовка к встрече», 13.10.2026): лояльность, ключ для следующей встречи, PING_CONTEXT.
-- Одна строка на сделку; текст — markdown в формате shtab-docs/DEBRIEF-PLAN.md.
CREATE TABLE IF NOT EXISTS prep_debrief (
  deal INTEGER PRIMARY KEY,
  text TEXT NOT NULL DEFAULT '',
  loyalty INTEGER,
  client TEXT NOT NULL DEFAULT '',
  company TEXT NOT NULL DEFAULT '',
  manager TEXT NOT NULL DEFAULT '',
  meeting_at TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  cost TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
