-- Состояние цепочки «подготовка → встреча → разбор» (15.10.2026): что сейчас с разбором по каждой сделке с подготовкой —
-- встреча впереди / ждём копию на Второй линии / ждём запись Zoom / распознаю / разбираю / ошибка / готово. Пишет collector/debrief.py auto.
CREATE TABLE IF NOT EXISTS debrief_queue (
  deal INTEGER PRIMARY KEY,           -- сделка с подготовкой
  l2 INTEGER,                         -- её копия на Второй линии (под этим номером лежит разбор)
  status TEXT NOT NULL DEFAULT '',    -- plan / wait / running / error / ready
  note TEXT NOT NULL DEFAULT '',
  client TEXT NOT NULL DEFAULT '',
  company TEXT NOT NULL DEFAULT '',
  manager TEXT NOT NULL DEFAULT '',
  meet_at TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL
);
