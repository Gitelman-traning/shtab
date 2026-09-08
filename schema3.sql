-- Штаб, миграция 3 (08.09.2026): вход через Telegram и заявки на доступ.
-- Применять: cd site && npx wrangler d1 execute shtab --remote --yes --file ../schema3.sql

ALTER TABLE users ADD COLUMN tg_id INTEGER;          -- id аккаунта Telegram
ALTER TABLE users ADD COLUMN tg_username TEXT;       -- @username на момент входа
ALTER TABLE users ADD COLUMN photo TEXT;             -- аватар из Telegram
CREATE UNIQUE INDEX IF NOT EXISTS users_tg ON users (tg_id);
-- Роль 'pending' = заявка ждёт подтверждения администратора; active = 0 до подтверждения.
