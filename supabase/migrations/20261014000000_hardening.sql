-- Hardening migration (safe to run more than once; adds only, never drops or rewrites data).
-- 1. Idempotency keys so a retried request cannot add stock or an expense twice.
-- 2. Double-booking is refused by the database itself, not only by the API.
-- 3. Tables created in future stay closed to Supabase's public REST API.

alter table expenses add column if not exists idem text;
create unique index if not exists ux_expenses_idem on expenses(idem) where idem is not null;
alter table stock_moves add column if not exists idem text;
create unique index if not exists ux_stock_moves_idem on stock_moves(idem) where idem is not null;

create or replace function pos_booking_overlap() returns trigger language plpgsql as $$
begin
  if new.status in ('reserved','in') then
    -- serialise writers per room so two sessions cannot both pass the check
    perform pg_advisory_xact_lock(hashtext('pos-booking:' || new.room_no));
    if exists (select 1 from bookings b where b.room_no = new.room_no and b.id <> new.id and b.status in ('reserved','in')
               and b.date_in < new.date_out and b.date_out > new.date_in) then
      raise exception 'Room % is already booked for those dates.', new.room_no using errcode = '23P01';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists bookings_no_overlap on bookings;
create trigger bookings_no_overlap before insert or update of room_no, date_in, date_out, status on bookings
  for each row execute function pos_booking_overlap();

alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;
