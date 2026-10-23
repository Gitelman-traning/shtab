-- Штаб, миграция 35 (23.10.2026): файлы в комментариях к задачам (миграция 34).
-- Файл любого типа (md, pdf, docx, таблицы, архивы) до 10 МБ крепится к комментарию: comment = task_log.id.
-- Пусто — файл задачи (скриншоты из карточки). Картинки отдаются для просмотра, текст (md, txt, csv) — как простой текст,
-- остальное — только скачиванием.
-- Применять: cd site && CLOUDFLARE_ACCOUNT_ID=4c42f9a718e4aeee45e5e2a57a9d795f npx wrangler -c wrangler.reference.toml d1 execute shtab --remote --yes --file ../schema35.sql

ALTER TABLE task_files ADD COLUMN comment INTEGER;
