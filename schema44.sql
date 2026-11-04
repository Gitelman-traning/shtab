CREATE TABLE IF NOT EXISTS source_health (
  source TEXT PRIMARY KEY, attempt TEXT NOT NULL, state TEXT NOT NULL,
  period TEXT NOT NULL, detail TEXT NOT NULL, updated TEXT NOT NULL,
  last_success TEXT, last_period TEXT
);
