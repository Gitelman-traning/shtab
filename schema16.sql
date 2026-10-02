-- Штаб, миграция 16 (02.10.2026): журнал пингов Второй линии — что бот подготовил менеджеру (полуручной режим)
CREATE TABLE IF NOT EXISTS pings (
  day        TEXT NOT NULL,          -- YYYY-MM-DD (МСК)
  manager    TEXT NOT NULL,          -- ключ карточки, например krotov
  deal       INTEGER NOT NULL,       -- id сделки amo
  text       TEXT NOT NULL DEFAULT '',
  reason     TEXT NOT NULL DEFAULT '',
  updated_at TEXT,
  PRIMARY KEY (day, manager, deal)
);
CREATE INDEX IF NOT EXISTS pings_manager_deal ON pings (manager, deal);
