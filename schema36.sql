-- Штаб, миграция 36 (23.10.2026): журнал страницы «Проверка связи с АТС» (/pbx-check, открыта без входа).
-- API создаёт таблицу и сам, если миграцию ещё не применили.
-- Применять: cd site && CLOUDFLARE_ACCOUNT_ID=4c42f9a718e4aeee45e5e2a57a9d795f npx wrangler -c wrangler.reference.toml d1 execute shtab --remote --yes --file ../schema36.sql

CREATE TABLE IF NOT EXISTS pbx_checks (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, name TEXT, verdict TEXT, summary TEXT, details TEXT, ip TEXT, place TEXT, ua TEXT);
