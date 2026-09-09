-- Штаб, миграция 7 (09.09.2026): касания и разговоры в разделе Первой линии
UPDATE sections SET config='{"metrics":["l1.leads","l1.booked","l2.held","l1m.leads","l1m.booked","l1m.held","l1m.touches","l1m.calls","l1m.talk"],"dims":true}' WHERE id='sales.l1';
