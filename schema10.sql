-- Штаб, миграция 10 (10.09.2026): справочник тегов сделок и правила служебных тегов
CREATE TABLE IF NOT EXISTS tags (
  tag        TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,              -- m маркетинговый · s служебный
  note       TEXT,
  set_by     TEXT,
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS tag_rules (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  pattern    TEXT NOT NULL,              -- регулярное выражение, без учёта регистра
  note       TEXT,
  created_by TEXT,
  created_at TEXT
);
INSERT INTO tag_rules (pattern, note, created_by, created_at) VALUES
  ('^WZ \(', 'WZ (…) — метка канала WhatsApp, ставится автоматически', 'system', '2026-09-10'),
  ('^bot$', 'bot — лид пришёл через бота, не источник трафика', 'system', '2026-09-10'),
  ('^отписался$', 'отписался — статус подписчика', 'system', '2026-09-10'),
  ('^None$', 'None — пустое значение из интеграции', 'system', '2026-09-10'),
  ('^передан-', 'передан-отделу-заботы и подобные — передача сделки', 'system', '2026-09-10'),
  ('^\d+$', 'только цифры — технические метки', 'system', '2026-09-10'),
  ('^(highpriority|newdate\d+)$', 'приоритет и служебные даты бота', 'system', '2026-09-10');
