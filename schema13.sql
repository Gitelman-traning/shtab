-- Штаб, миграция 13 (10.09.2026): индекс под MAX(asof) по показателю — экономия чтений D1
CREATE INDEX IF NOT EXISTS points_metric_asof ON points (metric, ptype, asof);
