-- Независимый утренний запуск сборщика: блокировка повторных запусков и результат проверки.
CREATE TABLE IF NOT EXISTS collector_refresh (
  period TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  dispatched_at INTEGER NOT NULL DEFAULT 0,
  checked_at INTEGER NOT NULL,
  detail TEXT NOT NULL DEFAULT ''
);
