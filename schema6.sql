-- Штаб, миграция 6 (09.09.2026): метрики менеджеров в разделе Первой линии
UPDATE sections SET config='{"metrics":["l1.leads","l1.booked","l2.held","l1m.leads","l1m.booked","l1m.held","l1m.events","l1m.calls"],"dims":true}' WHERE id='sales.l1';
