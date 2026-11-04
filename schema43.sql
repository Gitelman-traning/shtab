CREATE TABLE IF NOT EXISTS security_usage (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, actor TEXT NOT NULL, ip TEXT NOT NULL,
  at INTEGER NOT NULL, units INTEGER NOT NULL DEFAULT 0, lease_until INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS usage_actor ON security_usage(kind,actor,at);
CREATE INDEX IF NOT EXISTS usage_ip ON security_usage(kind,ip,at);
CREATE INDEX IF NOT EXISTS usage_time ON security_usage(at);
CREATE INDEX IF NOT EXISTS usage_lease ON security_usage(lease_until);
