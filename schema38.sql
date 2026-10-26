-- Штаб, миграция 38 (26.10.2026): Маркетинг → YouTube → Сделки и выручка.
-- YouTube-сделка = поле «Источник» (1439087) = YouTube (enum 1218221) или SHORTS Youtube (1229449), либо utm_source / utm_medium
-- содержит youtube (переход с YouTube на сайт), созданная с 26.07.2025.
-- Наполняет collector/youtube.py (youtube.yml): ночью — сделки, изменённые за 3 дня, вручную mode=full — все с 26.07.2025.
-- Оплаты Второй линии (9701010 и архивная 8733518, статус 142) хранятся все, а не только YouTube: страница сама считает
-- «оплаты через контакт» — оплаченные сделки, у контакта которых есть хоть одна YouTube-сделка.
-- Раздел marketing.youtube.deals закрыт по умолчанию (выручка): видят админы, те, кому выдано явно, и «правка» на YouTube.
-- Применять: cd site && CLOUDFLARE_ACCOUNT_ID=4c42f9a718e4aeee45e5e2a57a9d795f npx wrangler -c wrangler.reference.toml d1 execute shtab --remote --yes --file ../schema38.sql

CREATE TABLE IF NOT EXISTS yt_leads (
  id           INTEGER PRIMARY KEY,              -- id сделки amo
  created_at   INTEGER NOT NULL,                 -- unix, как отдаёт amo
  closed_at    INTEGER,                          -- unix, когда сделка ушла в 142/143
  pipeline_id  INTEGER NOT NULL,
  status_id    INTEGER NOT NULL,
  price        INTEGER NOT NULL DEFAULT 0,
  contact_id   INTEGER,                          -- основной контакт
  src          TEXT NOT NULL DEFAULT 'YouTube',  -- YouTube | SHORTS Youtube (поле «Источник») | utm_source | utm_medium
  utm_source   TEXT NOT NULL DEFAULT '',
  utm_medium   TEXT NOT NULL DEFAULT '',
  utm_campaign TEXT NOT NULL DEFAULT '',
  utm_content  TEXT NOT NULL DEFAULT '',
  channel      TEXT NOT NULL DEFAULT '',         -- тег канала Wazzup «WZ (…)», если есть
  meeting      INTEGER NOT NULL DEFAULT 0,       -- 1: Первая линия 8733326, статус 142 «Встреча проведена»
  paid         INTEGER NOT NULL DEFAULT 0,       -- 1: Вторая линия 9701010/8733518, статус 142 «100% оплаты получено»
  updated_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS yt_leads_contact ON yt_leads (contact_id);

CREATE TABLE IF NOT EXISTS yt_paid (
  id           INTEGER PRIMARY KEY,              -- оплаченная сделка Второй линии (любой источник), созданная с 26.07.2025
  contact_id   INTEGER,
  pipeline_id  INTEGER NOT NULL,
  price        INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL,
  closed_at    INTEGER,
  updated_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS yt_paid_contact ON yt_paid (contact_id);

INSERT OR IGNORE INTO sections (id, name, owner, config) VALUES
  ('marketing.youtube.deals', 'Маркетинг · YouTube · Сделки и выручка (закрыто по умолчанию)', '', '{}');
