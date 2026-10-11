-- Schema for the customer-support assistant (MVP).
-- See docs/design.md section 13 for how these tables are used.
--
-- Safe to re-run: every statement is idempotent.
-- Note this is not a migration tool - "create table if not exists" will NOT
-- alter a table that already exists with different columns. To change a column,
-- write an explicit "alter table" instead of editing the definition below.

-- ---------------------------------------------------------------------------
-- orders
-- ---------------------------------------------------------------------------
-- Customer orders. Only status 'processing' is cancellable (gate G4).
-- id is a 4-digit string like '1002'. The 4-digit rule is gate G1 and is
-- enforced in code, not by a constraint here.
create table if not exists orders (
  id           text        primary key,
  customer_id  text        not null,
  status       text        not null
               check (status in ('processing', 'shipped', 'delivered', 'cancelled')),
  item_summary text        not null,
  created_at   timestamptz not null default now()
);

-- Backs getLatestOrder(customerId): most recent order for a customer, any status.
create index if not exists orders_customer_created_at_idx
  on orders (customer_id, created_at desc);

-- Backs the cancel flow's lookup of a customer's cancellable orders.
create index if not exists orders_customer_status_idx
  on orders (customer_id, status);

-- ---------------------------------------------------------------------------
-- session_state
-- ---------------------------------------------------------------------------
-- One row per session: where the customer is in a flow. There is no chat
-- history here - the state JSON is the only memory the server keeps.
-- customer_id is a column, not part of the state JSON. When real auth arrives
-- it comes from auth instead of the fixed demo customer.
create table if not exists session_state (
  session_id  text        primary key,
  customer_id text        not null,
  state       jsonb       not null default '{}',
  updated_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- handoff_tickets
-- ---------------------------------------------------------------------------
-- One row per handoff to a human (simulated - nothing consumes these yet).
-- message is the customer's problem text.
create table if not exists handoff_tickets (
  id          bigint      generated always as identity primary key,
  session_id  text        not null,
  customer_id text        not null,
  message     text        not null,
  created_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------
-- RLS is enabled on all three tables with NO policies at all.
--
-- With RLS on and no policy, every row is denied to normal roles - so the
-- public/anon key can read and write nothing. The server uses the
-- service_role key, which bypasses RLS entirely, so it keeps full access.
--
-- This is why the service-role key must stay server-side only (see CLAUDE.md).
-- Re-running these statements is harmless; they are already-enabled no-ops.
alter table orders          enable row level security;
alter table session_state   enable row level security;
alter table handoff_tickets enable row level security;
