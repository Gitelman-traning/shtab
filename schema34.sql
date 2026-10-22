-- Штаб, миграция 34 (22.10.2026): скриншоты в задачах (миграции 23, 32).
-- Сама картинка лежит в KV (OKK_KV, ключ task-file:<key>), здесь — список: к какой задаче, кто и когда прикрепил.
-- Отдаёт /api/tasks/file?id=N тем, кто видит задачу. Удалить может тот, кто прикрепил, постановщик и админ.
-- В ленте task_log новые виды: file (прикрепил, text — имя файла) и unfile (удалил).
-- Применять: cd site && CLOUDFLARE_ACCOUNT_ID=4c42f9a718e4aeee45e5e2a57a9d795f npx wrangler -c wrangler.reference.toml d1 execute shtab --remote --yes --file ../schema34.sql

CREATE TABLE IF NOT EXISTS task_files (
  id    INTEGER PRIMARY KEY AUTOINCREMENT,
  task  INTEGER NOT NULL,
  login TEXT NOT NULL,                        -- кто прикрепил
  at    TEXT NOT NULL,
  name  TEXT NOT NULL DEFAULT '',
  type  TEXT NOT NULL,                        -- image/png · image/jpeg · image/webp · image/gif
  size  INTEGER NOT NULL,
  key   TEXT NOT NULL                         -- ключ в KV без префикса
);
CREATE INDEX IF NOT EXISTS task_files_task ON task_files (task, id);
