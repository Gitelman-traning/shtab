-- Штаб, миграция 14 (11.09.2026): справочные записи для чата с ИИ (структура компании, карта разделов) — текст заводится отдельно, в код не попадает
CREATE TABLE IF NOT EXISTS knowledge (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  text TEXT NOT NULL,
  updated_by TEXT,
  updated_at TEXT
);
