-- Штаб, миграция 17 (05.10.2026): подготовка диагноста к встрече (/sales/l2/prep/, collector/prep.py)
CREATE TABLE IF NOT EXISTS prep (
  deal        INTEGER PRIMARY KEY,     -- сделка Первой линии на этапе «Встреча подтверждена»
  contact     INTEGER,
  meet_at     TEXT NOT NULL DEFAULT '',-- YYYY-MM-DD HH:MM МСК
  manager     TEXT NOT NULL DEFAULT '',-- диагност (ответственный копии на Второй линии)
  client      TEXT NOT NULL DEFAULT '',-- имя клиента
  company     TEXT NOT NULL DEFAULT '',
  niche       TEXT NOT NULL DEFAULT '',
  turn        TEXT NOT NULL DEFAULT '',
  staff       TEXT NOT NULL DEFAULT '',
  geo         TEXT NOT NULL DEFAULT '',
  quiz_url    TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'queued',  -- queued / ready / error
  facts       TEXT NOT NULL DEFAULT '',        -- досье по открытым источникам (markdown)
  sources     TEXT NOT NULL DEFAULT '[]',      -- [{url,title}]
  cases       TEXT NOT NULL DEFAULT '[]',      -- [{deal,company,...,why,growth}]
  brief       TEXT NOT NULL DEFAULT '',        -- подготовка (markdown, 16 разделов)
  model       TEXT NOT NULL DEFAULT '',
  tokens_in   INTEGER NOT NULL DEFAULT 0,
  tokens_out  INTEGER NOT NULL DEFAULT 0,
  searches    INTEGER NOT NULL DEFAULT 0,
  amo_url     TEXT NOT NULL DEFAULT '',
  error       TEXT NOT NULL DEFAULT '',
  queued_by   TEXT NOT NULL DEFAULT '',
  created_at  TEXT,
  updated_at  TEXT
);
CREATE INDEX IF NOT EXISTS prep_meet ON prep (meet_at);

-- база участников для подбора кейсов: купившие из amo (собирает prep.py cases), позже — Excel «Участники тренинга НИШИ»
CREATE TABLE IF NOT EXISTS prep_cases (
  deal        INTEGER PRIMARY KEY,
  pipeline    INTEGER,
  name        TEXT NOT NULL DEFAULT '',
  company     TEXT NOT NULL DEFAULT '',
  niche       TEXT NOT NULL DEFAULT '',
  sphere      TEXT NOT NULL DEFAULT '',
  turn        TEXT NOT NULL DEFAULT '',
  staff       TEXT NOT NULL DEFAULT '',
  site        TEXT NOT NULL DEFAULT '',
  role        TEXT NOT NULL DEFAULT '',
  city        TEXT NOT NULL DEFAULT '',
  country     TEXT NOT NULL DEFAULT '',
  paid_at     TEXT NOT NULL DEFAULT '',
  result      TEXT NOT NULL DEFAULT '',        -- «как стало» из Excel/отзывов, когда появится
  updated_at  TEXT
);

CREATE TABLE IF NOT EXISTS prep_feedback (
  deal        INTEGER NOT NULL,
  login       TEXT NOT NULL,
  useful      INTEGER NOT NULL DEFAULT 1,
  comment     TEXT NOT NULL DEFAULT '',
  at          TEXT,
  PRIMARY KEY (deal, login)
);
