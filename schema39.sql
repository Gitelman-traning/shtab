-- Штаб, миграция 39 (26.10.2026): YouTube → Сделки и выручка — список сделок по клику на цифру.
-- Названия сделок, имена контактов и этап, чтобы окно со списком читалось без похода в amo. Наполняет collector/youtube.py;
-- после миграции один раз запустить «YouTube deals» с mode=full, иначе у старых строк названия пустые.
-- Применять: cd site && CLOUDFLARE_ACCOUNT_ID=4c42f9a718e4aeee45e5e2a57a9d795f npx wrangler -c wrangler.reference.toml d1 execute shtab --remote --yes --file ../schema39.sql

ALTER TABLE yt_leads ADD COLUMN name TEXT NOT NULL DEFAULT '';           -- название сделки (номера телефонов вырезаны)
ALTER TABLE yt_leads ADD COLUMN contact_name TEXT NOT NULL DEFAULT '';
ALTER TABLE yt_leads ADD COLUMN stage TEXT NOT NULL DEFAULT '';          -- «Воронка / Этап»
ALTER TABLE yt_paid ADD COLUMN name TEXT NOT NULL DEFAULT '';
ALTER TABLE yt_paid ADD COLUMN contact_name TEXT NOT NULL DEFAULT '';
