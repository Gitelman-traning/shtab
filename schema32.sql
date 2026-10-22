-- Штаб, миграция 32 (22.10.2026): проекты и подзадачи в задачах (миграция 23).
-- Проект — набор задач и его участники. Участники видят все задачи проекта и получают по ним уведомления как наблюдатели;
-- кому задача не нужна, выходит из неё кнопкой «Не наблюдать» (запись в task_mutes, выход из задачи действует и на её подзадачи).
-- Подзадача — задача с parent: свой исполнитель и срок, проект берёт у родителя. Вложенность одна: у подзадачи подзадач нет.
-- Проекты и участников заводит админ на странице «Задачи».
-- В ленте task_log два новых вида: sub (добавлена подзадача, text — её название) и watch (вышел из наблюдателей / стал наблюдателем).
-- Применять: cd site && npx wrangler d1 execute shtab --remote --yes --file ../schema32.sql

CREATE TABLE IF NOT EXISTS task_projects (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  about      TEXT NOT NULL DEFAULT '',
  archived   INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS task_project_members (
  project INTEGER NOT NULL,
  login   TEXT NOT NULL,                      -- users.login
  PRIMARY KEY (project, login)
);
CREATE INDEX IF NOT EXISTS task_project_members_login ON task_project_members (login);

-- участник проекта вышел из наблюдения за задачей
CREATE TABLE IF NOT EXISTS task_mutes (
  task  INTEGER NOT NULL,
  login TEXT NOT NULL,
  PRIMARY KEY (task, login)
);

ALTER TABLE tasks ADD COLUMN project INTEGER;   -- task_projects.id; пусто = без проекта
ALTER TABLE tasks ADD COLUMN parent INTEGER;    -- tasks.id родительской задачи; пусто = обычная задача
CREATE INDEX IF NOT EXISTS tasks_project ON tasks (project, status);
CREATE INDEX IF NOT EXISTS tasks_parent ON tasks (parent);

-- два проекта, с которых начинаем: Никита и Анна Агапова
INSERT OR IGNORE INTO task_projects (id, name, about, created_by, created_at) VALUES
  (1, 'Бот и маркетинг', 'Бот, рассылки, выдача материалов, теги', 'nikita', '2026-10-22T08:00:00.000Z'),
  (2, 'Сайт и SEO', 'Статьи, продвижение, SEO', 'nikita', '2026-10-22T08:00:00.000Z');
INSERT OR IGNORE INTO task_project_members (project, login) VALUES
  (1, 'nikita'), (1, 'agapovaann'), (2, 'nikita'), (2, 'agapovaann');
