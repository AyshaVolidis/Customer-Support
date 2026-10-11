-- Demo data for the customer-support assistant (MVP).
-- Run supabase/schema.sql first. See supabase/README.md.
--
-- Safe to re-run: "on conflict (id) do nothing" means existing rows are left
-- alone. Note that also means re-running will NOT refresh created_at - to move
-- the dates, delete the rows first (see the reset snippet in README.md).
--
-- created_at values are relative to now() and deliberately all distinct, so
-- "most recent order" is unambiguous.

insert into orders (id, customer_id, status, item_summary, created_at) values
  -- cust_001: the demo customer (see src/lib/config.ts when it exists)
  ('1001', 'cust_001', 'delivered',  'Laptop stand',        now() - interval '30 days'),
  ('1002', 'cust_001', 'shipped',    'USB-C cable',         now() - interval '6 days'),
  ('1003', 'cust_001', 'processing', 'Phone case',          now() - interval '8 days'),
  ('1004', 'cust_001', 'cancelled',  'Desk lamp',           now() - interval '12 days'),
  ('1005', 'cust_001', 'processing', 'Wireless headphones', now() - interval '5 days'),
  -- 1006 repeats 1005's item name on purpose, to exercise label disambiguation
  ('1006', 'cust_001', 'processing', 'Wireless headphones', now() - interval '2 days'),

  -- cust_002: a second customer, so ownership checks (gate G3) can be tested
  ('2001', 'cust_002', 'processing', 'Yoga mat',            now() - interval '3 days'),
  ('2002', 'cust_002', 'shipped',    'Water bottle',        now() - interval '9 days')
on conflict (id) do nothing;

-- What this data gives you:
--
--   cust_001 cancellable orders (status = 'processing'):  1003, 1005, 1006
--   cust_001 most recent order (any status):              1006
--   not cancellable:                                      1001, 1002, 1004
--   belongs to someone else (G3 must hide it):            2001, 2002
