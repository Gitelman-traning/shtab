CREATE TABLE IF NOT EXISTS section_draft_jobs (
  id TEXT PRIMARY KEY, section TEXT NOT NULL, login TEXT NOT NULL,
  created TEXT NOT NULL, deadline TEXT NOT NULL, result TEXT, status INTEGER
);
CREATE INDEX IF NOT EXISTS draft_jobs_created ON section_draft_jobs(created);
