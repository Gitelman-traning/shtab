-- Штаб, миграция 4 (09.09.2026): права по разделам на каждого пользователя.
-- Применять: cd site && npx wrangler d1 execute shtab --remote --yes --file ../schema4.sql

-- level: 0 закрыт, 1 просмотр, 2 редактирование. Подразделы наследуют право отдела, если своей строки нет.
CREATE TABLE IF NOT EXISTS perms (
  login   TEXT NOT NULL,
  section TEXT NOT NULL,
  level   INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (login, section)
);
