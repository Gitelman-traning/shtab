-- Версии разбора встречи (14.10.2026): все прогоны разных моделей и ручные эталоны — для сравнения на странице «Разбор встречи».
CREATE TABLE IF NOT EXISTS prep_debrief_ver (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  deal INTEGER NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  text TEXT NOT NULL DEFAULT '',
  loyalty INTEGER,
  model TEXT NOT NULL DEFAULT '',
  cost TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS prep_debrief_ver_deal ON prep_debrief_ver (deal);
