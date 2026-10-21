-- Уведомления в Telegram по подписке (21.10.2026): у пользователя список тем через запятую, например «journal».
-- Шлёт бот Штаба (TG_BOT_TOKEN) на users.tg_id; галочки ставит админ на «Пользователях» и сам человек в меню у своего имени.
ALTER TABLE users ADD COLUMN notify TEXT NOT NULL DEFAULT '';
