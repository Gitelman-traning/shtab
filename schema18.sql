-- Штаб, миграция 18 (05.10.2026): база «было → стало» — дата проверки роста участника (prep.py growth)
ALTER TABLE prep_cases ADD COLUMN checked_at TEXT NOT NULL DEFAULT '';
