-- Штаб, миграция 15 (25.09.2026): окна менеджеров Первой линии — цифры дня с пруф-списками сделок и цели по деньгам
-- okna: одна строка = один показатель одного менеджера на один день окна; items — JSON-список [[id сделки, подпись, имя], ...]
-- (для ключа shifts — список дней смен). Пишет сборщик collector/okna.py через /api/ingest (body.okna).
CREATE TABLE IF NOT EXISTS okna (
  day        TEXT NOT NULL,          -- день окна, YYYY-MM-DD (срез на 00:00)
  mgr        TEXT NOT NULL,          -- Маргарита / Алина / Юлия / Полина
  key        TEXT NOT NULL,          -- cond, lost, tails, ahead, leads, answered, ca, ca_booked, ca_nobook, ca_notca, month_leads, shifts
  n          INTEGER NOT NULL DEFAULT 0,
  items      TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT,
  PRIMARY KEY (day, mgr, key)
);
-- цели менеджера на месяц: запрос по деньгам, оклад и ставка за проведённую встречу «в зачёт»
CREATE TABLE IF NOT EXISTS okna_goals (
  mgr        TEXT NOT NULL,
  month      TEXT NOT NULL,          -- YYYY-MM
  goal       REAL NOT NULL,          -- «хочу в месяце», рублей
  base       REAL NOT NULL DEFAULT 25000,
  rate       REAL NOT NULL DEFAULT 1500,
  note       TEXT,
  set_by     TEXT,
  updated_at TEXT,
  PRIMARY KEY (mgr, month)
);
INSERT OR IGNORE INTO okna_goals (mgr, month, goal, base, rate, note, set_by, updated_at) VALUES
  ('Маргарита', '2026-09', 160000, 25000, 1500, 'запрос Марго: 90 проведённых встреч', 'migration', '2026-09-25T00:00:00Z'),
  ('Алина',     '2026-09', 137500, 25000, 1500, 'цель Людмилы 24.09: 75 проведённых встреч', 'migration', '2026-09-25T00:00:00Z'),
  ('Юлия',      '2026-09', 137500, 25000, 1500, 'цель Людмилы 24.09: 75 проведённых встреч', 'migration', '2026-09-25T00:00:00Z'),
  ('Полина',    '2026-09', 137500, 25000, 1500, 'план из личного листа: 75 проведённых встреч', 'migration', '2026-09-25T00:00:00Z');
