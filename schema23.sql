-- Штаб, миграция 23 (07.10.2026): задачи между сотрудниками, как в Битрикс.
-- Постановщик, исполнитель, наблюдатели, срок, статусы с шагом «на контроле»; комментарии и история в одной ленте.
-- Люди — по логину Штаба (users.login): задачу можно поставить только тому, у кого есть вход. Руководитель видит
-- задачи подчинённых по структуре HR (hr_people.manager и hr_depts.head, миграция 22).
-- Применять: cd site && npx wrangler d1 execute shtab --remote --yes --file ../schema23.sql

CREATE TABLE IF NOT EXISTS tasks (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  title      TEXT NOT NULL,
  body       TEXT NOT NULL DEFAULT '',
  author     TEXT NOT NULL,                   -- постановщик, users.login
  assignee   TEXT NOT NULL,                   -- исполнитель, users.login
  due        TEXT,                            -- срок: ГГГГ-ММ-ДД или ГГГГ-ММ-ДДTЧЧ:ММ (по Москве); пусто = без срока
  important  INTEGER NOT NULL DEFAULT 0,
  status     TEXT NOT NULL DEFAULT 'new',     -- new ждёт · work в работе · review на контроле · done готово · deferred отложена · cancelled отменена
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  done_at    TEXT,
  reminded   TEXT NOT NULL DEFAULT ''         -- какие напоминания о сроке уже ушли: «d1,d0,late»
);
CREATE INDEX IF NOT EXISTS tasks_assignee ON tasks (assignee, status);
CREATE INDEX IF NOT EXISTS tasks_author ON tasks (author, status);
CREATE INDEX IF NOT EXISTS tasks_due ON tasks (status, due);

CREATE TABLE IF NOT EXISTS task_watchers (
  task  INTEGER NOT NULL,
  login TEXT NOT NULL,
  PRIMARY KEY (task, login)
);
CREATE INDEX IF NOT EXISTS task_watchers_login ON task_watchers (login);

-- лента задачи: комментарии и события (создана, сменился статус, срок, исполнитель)
CREATE TABLE IF NOT EXISTS task_log (
  id    INTEGER PRIMARY KEY AUTOINCREMENT,
  task  INTEGER NOT NULL,
  at    TEXT NOT NULL,
  login TEXT NOT NULL,
  kind  TEXT NOT NULL,                        -- comment · create · status · edit
  text  TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS task_log_task ON task_log (task, id);

INSERT OR IGNORE INTO sections (id, name, owner, config) VALUES ('tasks', 'Задачи', '', '{}');
