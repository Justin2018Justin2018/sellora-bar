-- Keg / litre-based stock. Adds optional metadata to products; existing rows and behaviour are unchanged.
--   unit       : label shown next to stock ('unit' by default, 'L' for a keg counted in litres)
--   pack_size  : capacity of one keg in litres (NULL for ordinary items)
--   pack_cost_c: purchase price of one keg in cents
--   price_opts : JSON array of the only selling prices an administrator may choose (cents), e.g. [21000,25000]
alter table products add column if not exists unit text not null default 'unit';
alter table products add column if not exists pack_size double precision;
alter table products add column if not exists pack_cost_c bigint;
alter table products add column if not exists price_opts text;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'products_pack_chk') then
    alter table products add constraint products_pack_chk check ((pack_size is null or pack_size > 0) and (pack_cost_c is null or pack_cost_c >= 0));
  end if;
end $$;
