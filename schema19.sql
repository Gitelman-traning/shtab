-- Штаб, миграция 19 (06.10.2026): стиль вопросов диагноста из его расшифровок (prep.py style) — подставляется в подготовку
CREATE TABLE IF NOT EXISTS prep_style (
  manager    TEXT PRIMARY KEY,     -- имя диагноста как в amo («Евгений Кротов»)
  text       TEXT NOT NULL DEFAULT '',
  meetings   INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT
);
