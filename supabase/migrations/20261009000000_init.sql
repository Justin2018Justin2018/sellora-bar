-- Savanna Lodge POS: Postgres schema (ported 1:1 from the SQLite schema).
-- Money = integer cents (bigint). Timestamps are ISO-8601 text, exactly as the app writes them.

create table if not exists users(
  id text primary key, username text not null, name text not null,
  role text not null check(role in('admin','manager','cashier','bartender','waiter','kitchen','receptionist','storekeeper')),
  pw_salt text not null, pw_hash text not null, active integer not null default 1 check(active in(0,1)), created_at text not null);
create unique index if not exists ux_users_username on users(lower(username));

create table if not exists sessions(token_hash text primary key, user_id text not null references users(id), created_at text, last_seen text, expires_at text not null);
create table if not exists login_attempts(id bigserial primary key, k text not null, ts text not null);
create index if not exists ix_login_attempts on login_attempts(k, ts);

create table if not exists products(
  id text primary key, name text not null, cat text not null, dept text not null check(dept in('bar','rest','store')),
  price_c bigint not null default 0 check(price_c>=0), cost_c bigint not null default 0 check(cost_c>=0),
  stock double precision not null default 0 check(stock>=0), reorder double precision not null default 0 check(reorder>=0), active integer not null default 1);
create unique index if not exists ux_products_name on products(lower(name));

create table if not exists recipes(product_id text not null references products(id), ingredient_id text not null references products(id), qty double precision not null check(qty>0), primary key(product_id,ingredient_id));
create table if not exists rooms(no text primary key, type text not null, rate_c bigint not null check(rate_c>0), status text not null default 'vacant' check(status in('vacant','occupied','dirty','maintenance')));

create table if not exists bookings(
  id text primary key, room_no text not null references rooms(no), guest text not null, phone text, date_in text not null, date_out text not null,
  status text not null check(status in('reserved','in','out','cancelled')), created_by text, created_at text, in_at text, out_at text, cancel_reason text, check(date_out>date_in));
create index if not exists ix_book_room on bookings(room_no,status);

create table if not exists sales(
  id text primary key, token text not null unique, ts text not null, dept text not null check(dept in('bar','rest')), staff_id text not null references users(id), staff_name text not null,
  recorded_by text not null, table_no text, kitchen_status text not null check(kitchen_status in('pending','preparing','ready','served','done')),
  pay_mode text not null check(pay_mode in('paid','open','credit','room')), status text not null default 'active' check(status in('active','void','cancelled')),
  booking_id text references bookings(id), customer text, total_c bigint not null check(total_c>0), void_reason text);
create index if not exists ix_sales_ts on sales(ts);

create table if not exists sale_items(id bigserial primary key, sale_id text not null references sales(id), product_id text not null references products(id), name text not null,
  qty double precision not null check(qty>0), price_c bigint not null check(price_c>0), cost_c bigint not null check(cost_c>=0));
create index if not exists ix_items_sale on sale_items(sale_id);

create table if not exists payments(
  id text primary key, ts text not null, ref_type text not null check(ref_type in('sale','booking')), ref_id text not null,
  method text not null check(method in('Cash','M-Pesa','Card')), amount_c bigint not null check(amount_c<>0), kind text not null check(kind in('payment','refund')),
  user_id text, user_name text, idem text unique);
create index if not exists ix_pay_ref on payments(ref_type,ref_id);

create table if not exists charges(id text primary key, booking_id text not null references bookings(id), kind text not null check(kind in('room','sale','reversal')), ref text not null, descr text, amount_c bigint not null, ts text not null);
create unique index if not exists ux_charge_once on charges(kind,ref);

create table if not exists stock_moves(id text primary key, ts text not null, product_id text not null references products(id), qty double precision not null, reason text not null, ref text, user_name text);
create index if not exists ix_moves_ref on stock_moves(ref);
create table if not exists expenses(id text primary key, ts text not null, cat text not null, descr text not null, amount_c bigint not null check(amount_c>0), user_name text);
create table if not exists shifts(id text primary key, user_id text not null references users(id), user_name text, opened_at text not null, float_c bigint not null check(float_c>=0), closed_at text, expected_c bigint, counted_c bigint);
create unique index if not exists ux_one_open_shift on shifts(user_id) where closed_at is null;
create table if not exists price_log(id text primary key, ts text not null, user_name text, role text, product_id text, item text, changes text, reason text);
create table if not exists audit_log(id bigserial primary key, ts text not null, user_id text, user_name text, action text not null, detail text, ip text);

-- Append-only ledger: these records can never be edited or deleted, even by a bug in the app.
create or replace function pos_block() returns trigger language plpgsql as $$
begin raise exception '%', tg_argv[0]; end $$;

do $$
declare t text;
begin
  foreach t in array array['payments','charges','stock_moves','audit_log','price_log','sale_items'] loop
    execute format('drop trigger if exists %I on %I', t||'_no_update', t);
    execute format('create trigger %I before update on %I for each row execute function pos_block(%L)', t||'_no_update', t, t||' records are append-only');
    execute format('drop trigger if exists %I on %I', t||'_no_delete', t);
    execute format('create trigger %I before delete on %I for each row execute function pos_block(%L)', t||'_no_delete', t, t||' records cannot be deleted');
  end loop;
end $$;
drop trigger if exists sales_no_delete on sales;
create trigger sales_no_delete before delete on sales for each row execute function pos_block('sales cannot be deleted - void them');
drop trigger if exists bookings_no_delete on bookings;
create trigger bookings_no_delete before delete on bookings for each row execute function pos_block('bookings cannot be deleted - cancel them');

-- SECURITY: Supabase publishes every table in "public" through its REST API. The app talks to Postgres directly
-- (server side only), so lock the REST API out completely: RLS on, no policies, no grants for anon/authenticated.
do $$
declare t text;
begin
  foreach t in array array['users','sessions','login_attempts','products','recipes','rooms','bookings','sales','sale_items','payments','charges','stock_moves','expenses','shifts','price_log','audit_log'] loop
    execute format('alter table %I enable row level security', t);
    execute format('revoke all on %I from anon, authenticated', t);
  end loop;
end $$;
revoke all on all sequences in schema public from anon, authenticated;
