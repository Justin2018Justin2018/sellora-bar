-- Rollback for 20261014010000_keg.sql (redeploy the previous API first). Keg items stay as ordinary stock items counted in litres.
alter table products drop constraint if exists products_pack_chk;
alter table products drop column if exists price_opts;
alter table products drop column if exists pack_cost_c;
alter table products drop column if exists pack_size;
alter table products drop column if exists unit;
