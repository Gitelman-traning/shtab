-- HR (09.10.2026): Telegram сотрудника в структуре компании — @username, виден всем, кто видит структуру.
-- Применять: cd site && npx wrangler d1 execute shtab --remote --yes --file ../schema24.sql
ALTER TABLE hr_people ADD COLUMN tg TEXT NOT NULL DEFAULT '';
