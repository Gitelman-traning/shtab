-- Штаб, миграция 2 (08.09.2026): именные пользователи, журнал действий, разделы с собственным видом.
-- Применять: cd site && npx wrangler d1 execute shtab --remote --yes --file ../schema2.sql

ALTER TABLE users ADD COLUMN last_login TEXT;
ALTER TABLE users ADD COLUMN must_change INTEGER NOT NULL DEFAULT 0;   -- 1 = временный пароль, сменить при входе

CREATE TABLE IF NOT EXISTS audit (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  at      TEXT NOT NULL,
  login   TEXT NOT NULL,
  action  TEXT NOT NULL,      -- login, user.create, user.reset, user.disable, section.draft, section.publish, section.rollback ...
  target  TEXT,
  note    TEXT
);
CREATE INDEX IF NOT EXISTS audit_at ON audit (at);

-- Разделы, у которых может быть свой вид. config: какие показатели отдаём странице раздела.
INSERT OR IGNORE INTO sections (id, name, owner, config) VALUES
  ('marketing', 'Маркетинг', '', '{"metrics":["mkt.leads"],"dims":true}'),
  ('sales', 'Отдел продаж', '', '{"metrics":["l1.leads","l1.booked","l2.held","l2.sales"],"dims":true}');
