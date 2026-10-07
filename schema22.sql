-- HR (07.10.2026): структура компании, праздники, отпуска и больничные.
-- Даты рождения, дети и больничные — только для сотрудников HR (раздел hr.team); всем остальным API отдаёт день и месяц рождения и «отсутствует».
CREATE TABLE IF NOT EXISTS hr_depts (
  id         TEXT PRIMARY KEY,                -- латиница: sales, sales-l1 …
  name       TEXT NOT NULL,
  parent     TEXT NOT NULL DEFAULT '',        -- '' = отдел верхнего уровня
  head       INTEGER,                         -- hr_people.id руководителя отдела
  sort       INTEGER NOT NULL DEFAULT 100,
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS hr_people (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  position   TEXT NOT NULL DEFAULT '',
  dept       TEXT NOT NULL DEFAULT '',        -- hr_depts.id
  manager    INTEGER,                         -- hr_people.id непосредственного руководителя
  login      TEXT NOT NULL DEFAULT '',        -- users.login, если у человека есть вход в Штаб
  status     TEXT NOT NULL DEFAULT 'active',  -- active · left (уволен, виден только тем, кто правит)
  sort       INTEGER NOT NULL DEFAULT 100,
  birth      TEXT NOT NULL DEFAULT '',        -- ГГГГ-ММ-ДД или --ММ-ДД, если год неизвестен
  hired      TEXT NOT NULL DEFAULT '',        -- дата выхода в компанию, ГГГГ-ММ-ДД
  leave_year REAL NOT NULL DEFAULT 28,        -- дней отпуска в год
  leave_adj  REAL NOT NULL DEFAULT 0,         -- ручная поправка остатка, ± дней
  created_at TEXT,
  updated_at TEXT
);
CREATE INDEX IF NOT EXISTS hr_people_dept ON hr_people (dept);
CREATE TABLE IF NOT EXISTS hr_children (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  person     INTEGER NOT NULL,                -- hr_people.id
  name       TEXT NOT NULL,
  birth      TEXT NOT NULL DEFAULT ''         -- ГГГГ-ММ-ДД или --ММ-ДД
);
CREATE INDEX IF NOT EXISTS hr_children_person ON hr_children (person);
CREATE TABLE IF NOT EXISTS hr_leave (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  person     INTEGER NOT NULL,
  kind       TEXT NOT NULL DEFAULT 'vacation', -- vacation · sick · unpaid
  date_from  TEXT NOT NULL,
  date_to    TEXT NOT NULL,
  days       REAL NOT NULL,                    -- дней к списанию (по умолчанию календарные, HR может поправить)
  note       TEXT NOT NULL DEFAULT '',
  created_by TEXT,
  created_at TEXT
);
CREATE INDEX IF NOT EXISTS hr_leave_person ON hr_leave (person);
CREATE INDEX IF NOT EXISTS hr_leave_dates ON hr_leave (date_to);

-- черновик отделов по списку должностей Никиты 07.10; правится на странице
INSERT OR IGNORE INTO hr_depts (id, name, parent, sort) VALUES
  ('lead', 'Руководство', '', 10),
  ('ops', 'Операционный отдел', '', 20),
  ('fin', 'Финансы', '', 30),
  ('hr', 'HR', '', 40),
  ('sales', 'Отдел продаж', '', 50),
  ('sales-l1', 'Первая линия', 'sales', 51),
  ('sales-l2', 'Вторая линия', 'sales', 52),
  ('sales-camp', 'Кэмп', 'sales', 53),
  ('mkt', 'Маркетинг', '', 60),
  ('mkt-instagram', 'Instagram', 'mkt', 61),
  ('mkt-telegram', 'Telegram', 'mkt', 62),
  ('mkt-youtube', 'YouTube', 'mkt', 63),
  ('mkt-content', 'Контент', 'mkt', 64),
  ('mkt-influence', 'Инфлюенс', 'mkt', 65),
  ('care', 'Отдел заботы', '', 70),
  ('product', 'Продукт и разработка', '', 80),
  ('result', 'Результатор', '', 90);

-- разделы для прав (видны в «Пользователях»)
INSERT OR IGNORE INTO sections (id, name, owner, config) VALUES
  ('hr', 'HR', '', '{}'),
  ('hr.structure', 'HR · Структура компании', '', '{}'),
  ('hr.events', 'HR · Праздники', '', '{}'),
  ('hr.leave', 'HR · Отпуска', '', '{}'),
  ('hr.team', 'HR · Для HR (закрытая часть)', '', '{}');
