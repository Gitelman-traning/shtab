-- Штаб, миграция 17 (05.10.2026): бюджет и расходы проекта (раздел «Настройки → Бюджет и расходы», только админ)
-- expenses: одна строка = одна трата, пополнение или месячная подписка. ref — ключ для автоимпорта (повторный импорт не дублирует).
CREATE TABLE IF NOT EXISTS expenses (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  day         TEXT NOT NULL,                 -- YYYY-MM-DD
  service     TEXT NOT NULL,                 -- ProxyAPI, OpenRouter, Cloudflare, Deepgram, Apify, GitHub …
  item        TEXT NOT NULL DEFAULT '',      -- что именно: «ОКК разбор Sonnet 5», «коуч Opus 5.5», «Workers Paid»
  kind        TEXT NOT NULL DEFAULT 'spend', -- spend (трата по факту) | topup (пополнение баланса) | fixed (подписка за месяц)
  amount      REAL NOT NULL,                 -- в рублях
  currency    TEXT NOT NULL DEFAULT 'RUB',   -- исходная валюта
  amount_orig REAL,                          -- сумма в исходной валюте (если не рубли)
  qty         REAL,                          -- штук: разборов, минут, токенов — для справки
  note        TEXT NOT NULL DEFAULT '',
  source      TEXT NOT NULL DEFAULT 'manual',-- manual | okk-sheet | coach-sheet | pings | …
  ref         TEXT,                          -- уникальный ключ автоимпорта
  created_by  TEXT,
  created_at  TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS expenses_ref ON expenses (ref) WHERE ref IS NOT NULL;
CREATE INDEX IF NOT EXISTS expenses_day ON expenses (day);
-- план: фиксированные подписки и лимиты по сервисам
CREATE TABLE IF NOT EXISTS budget_plan (
  service     TEXT PRIMARY KEY,
  monthly_rub REAL NOT NULL DEFAULT 0,       -- ожидаемый расход в месяц (подписка или лимит)
  kind        TEXT NOT NULL DEFAULT 'limit', -- fixed (подписка) | limit (потолок переменных расходов)
  note        TEXT NOT NULL DEFAULT '',
  updated_by  TEXT,
  updated_at  TEXT
);
INSERT OR IGNORE INTO budget_plan (service, monthly_rub, kind, note, updated_by, updated_at) VALUES
  ('Cloudflare', 475, 'fixed', 'Workers Paid $5/мес (≈95 ₽ за $) — снимает лимит чтений D1', 'migration', '2026-10-05T00:00:00Z'),
  ('ProxyAPI', 10000, 'limit', 'модели для ОКК, коуча, пингов, чата Штаба; бюджет ОКК согласован до 10 000 ₽/мес', 'migration', '2026-10-05T00:00:00Z'),
  ('Deepgram', 0, 'limit', 'расшифровка встреч по минутам; оплата с отдельного аккаунта, сумму вносить из кабинета', 'migration', '2026-10-05T00:00:00Z');
