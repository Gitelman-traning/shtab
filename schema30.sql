-- Вводные подготовки (16.10.2026): что было в карточке amo — {company, site, turn, staff}. По пустым страница предлагает форму:
-- диагност дописывает, Штаб пишет это в сделку amo и запускает подготовку.
ALTER TABLE prep ADD COLUMN inputs TEXT NOT NULL DEFAULT '';
