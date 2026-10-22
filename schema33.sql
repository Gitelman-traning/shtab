-- Штаб, миграция 33 (22.10.2026). Уведомления в Telegram по подписке: у пользователя список тем через запятую, например «journal».
-- Шлёт бот Штаба (TG_BOT_TOKEN) на users.tg_id; галочки ставит админ на «Пользователях» и сам человек в меню у своего имени. Тема journal — кнопка «Вышла» в очереди статей журнала.
ALTER TABLE users ADD COLUMN notify TEXT NOT NULL DEFAULT '';
-- Применять: cd site && npx wrangler d1 execute shtab --remote --yes --file ../schema33.sql
