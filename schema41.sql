-- Временный пароль действителен сутки, включая временные пароли, выданные до миграции.
ALTER TABLE users ADD COLUMN temp_expires TEXT;
UPDATE users SET temp_expires=strftime('%Y-%m-%dT%H:%M:%fZ','now','+1 day') WHERE must_change=1;
