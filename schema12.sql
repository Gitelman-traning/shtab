-- Штаб, миграция 12 (10.09.2026): руководитель интеграции у тега (Инфлюенс)
ALTER TABLE tags ADD COLUMN owner TEXT;
