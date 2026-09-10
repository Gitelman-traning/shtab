-- Штаб, миграция 11 (10.09.2026): ЦА-лиды в данных разделов маркетинга
UPDATE sections SET config = replace(config, '"mkt.leads",', '"mkt.leads","mkt.qual",') WHERE id LIKE 'marketing.%' AND config NOT LIKE '%mkt.qual%';
UPDATE sections SET config = '{"metrics":["mkt.leads","mkt.qual"],"dims":true}' WHERE id = 'marketing';
