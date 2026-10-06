-- Штаб, миграция 21 (06.10.2026): база участников из таблицы Жени «Участники тренинга НИШИ» (prep.py sheet) рядом с купившими из amo
ALTER TABLE prep_cases ADD COLUMN source TEXT NOT NULL DEFAULT 'amo';   -- amo | sheet
