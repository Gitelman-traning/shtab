-- Штаб: витрина показателей. Применяется к D1 один раз (wrangler d1 execute --file schema.sql).

-- Реестр показателей: что это, чьё, как считается
CREATE TABLE IF NOT EXISTS metrics (
  id         TEXT PRIMARY KEY,      -- mkt.leads, l1.booked, pay.full ...
  name       TEXT NOT NULL,
  section    TEXT NOT NULL,         -- mkt.paid, mkt.organic, sales.l1, sales.l2, participants, finance
  unit       TEXT DEFAULT 'шт',
  kind       TEXT DEFAULT 'flow',   -- flow: складывается по дням; stock: снимок состояния на дату
  better     TEXT DEFAULT 'up',     -- up / down / none
  definition TEXT,
  updated_at TEXT
);

-- Точки фактов. Для flow: ptype='day', period='YYYY-MM-DD', asof=''.
-- Для stock (участники по потокам): ptype='potok', period='YYYY-MM' или 'shortlist', asof='YYYY-MM-DD' (дата снимка).
CREATE TABLE IF NOT EXISTS points (
  metric     TEXT NOT NULL,
  ptype      TEXT NOT NULL,
  period     TEXT NOT NULL,
  dim        TEXT NOT NULL DEFAULT '',   -- срез: источник, менеджер; '' = всего
  asof       TEXT NOT NULL DEFAULT '',
  value      REAL NOT NULL,
  source     TEXT,                       -- какой сборщик записал
  updated_at TEXT,
  PRIMARY KEY (metric, ptype, period, dim, asof)
);
CREATE INDEX IF NOT EXISTS points_metric_period ON points (metric, ptype, period);

-- Планы (цели) — вводят владельцы разделов
CREATE TABLE IF NOT EXISTS plans (
  metric     TEXT NOT NULL,
  ptype      TEXT NOT NULL,             -- day / week / month / potok
  period     TEXT NOT NULL,
  dim        TEXT NOT NULL DEFAULT '',
  value      REAL NOT NULL,
  set_by     TEXT,
  updated_at TEXT,
  PRIMARY KEY (metric, ptype, period, dim)
);

-- Пользователи и сессии (персональные логины)
CREATE TABLE IF NOT EXISTS users (
  login      TEXT PRIMARY KEY,
  pass_hash  TEXT NOT NULL,
  salt       TEXT NOT NULL,
  name       TEXT,
  role       TEXT NOT NULL DEFAULT 'member',   -- owner / admin / head / member / assistant
  sections   TEXT NOT NULL DEFAULT '',         -- через запятую; пусто у owner/admin = все
  active     INTEGER NOT NULL DEFAULT 1,
  created_at TEXT
);
CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT PRIMARY KEY,
  login      TEXT NOT NULL,
  expires    TEXT NOT NULL
);

-- Разделы и версии их представлений (для «своего вида через Claude» с откатом)
CREATE TABLE IF NOT EXISTS sections (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  owner      TEXT,
  config     TEXT                              -- JSON: какие показатели, какие виджеты
);
CREATE TABLE IF NOT EXISTS section_versions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  section    TEXT NOT NULL,
  version    INTEGER NOT NULL,
  html       TEXT NOT NULL,
  prompt     TEXT,
  author     TEXT,
  created_at TEXT,
  active     INTEGER NOT NULL DEFAULT 0
);

-- Журнал прогонов сборщиков
CREATE TABLE IF NOT EXISTS runs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  collector  TEXT NOT NULL,
  started    TEXT,
  finished   TEXT,
  points     INTEGER DEFAULT 0,
  note       TEXT
);
