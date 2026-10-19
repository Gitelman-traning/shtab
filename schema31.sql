-- База кейсов выпускников из отчётных презентаций трекинга (19.10.2026, формат — промт Жени): одна строка на кейс.
-- Источник — папка «Трекинг» (Google Drive), собирается локально и заливается целиком (ingest prep_alumni, replace).
CREATE TABLE IF NOT EXISTS prep_alumni (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id TEXT NOT NULL DEFAULT '',     -- презентация в Drive
  stream TEXT NOT NULL DEFAULT '',      -- поток
  company TEXT NOT NULL DEFAULT '',
  person TEXT NOT NULL DEFAULT '',
  niche TEXT NOT NULL DEFAULT '',
  region TEXT NOT NULL DEFAULT '',
  size TEXT NOT NULL DEFAULT '',        -- оборот / сотрудники, как в отчёте
  evidence TEXT NOT NULL DEFAULT '',    -- high / medium / low
  problems TEXT NOT NULL DEFAULT '',    -- теги проблем через «;»
  results TEXT NOT NULL DEFAULT '',     -- теги результата через «;»
  grow TEXT NOT NULL DEFAULT '',        -- главное «было → стало» с периодом
  pct TEXT NOT NULL DEFAULT '',         -- рост для полоски: «+29%», «×4,7» или пусто
  changed TEXT NOT NULL DEFAULT '',     -- что поменял
  say TEXT NOT NULL DEFAULT '',         -- фраза для клиента по шаблону Жени
  confirmed TEXT NOT NULL DEFAULT '',
  cannot TEXT NOT NULL DEFAULT '',      -- что нельзя утверждать
  when_use TEXT NOT NULL DEFAULT '',
  transition TEXT NOT NULL DEFAULT '',
  takeaway TEXT NOT NULL DEFAULT '',
  question TEXT NOT NULL DEFAULT '',
  ask_alumni TEXT NOT NULL DEFAULT '',  -- что спросить у выпускника, чтобы усилить
  updated_at TEXT NOT NULL
);
