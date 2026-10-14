-- Rollback for 20261014000000_hardening.sql. Run ONLY together with redeploying the previous API version.
-- Data is preserved: the idempotency columns are dropped (they hold request tokens only), no sales/stock/expense rows are touched.
drop trigger if exists bookings_no_overlap on bookings;
drop function if exists pos_booking_overlap();
drop index if exists ux_expenses_idem;
drop index if exists ux_stock_moves_idem;
alter table expenses drop column if exists idem;
alter table stock_moves drop column if exists idem;
