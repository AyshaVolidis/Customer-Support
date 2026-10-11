// Supabase-backed implementation of the repository interfaces.
// Server-side only: it uses the service-role key, which bypasses RLS.
// The client is created lazily so importing this file never needs env vars.

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import type {
  CancelResult,
  HandoffRepository,
  Order,
  OrderRepository,
  OrderStatus,
  SessionState,
  SessionStore,
} from './types';
import { idleState } from './types';

/** The orders table as it comes back from Postgres: snake_case columns. */
type OrderRow = {
  id: string;
  customer_id: string;
  status: OrderStatus;
  item_summary: string;
  created_at: string;
};

const ORDER_COLUMNS = 'id, customer_id, status, item_summary, created_at';

/** Map a database row to the camelCase Order the rest of the code uses. */
function toOrder(row: OrderRow): Order {
  return {
    id: row.id,
    customerId: row.customer_id,
    status: row.status,
    itemSummary: row.item_summary,
    createdAt: row.created_at,
  };
}

let client: SupabaseClient | null = null;

/**
 * Read one required environment variable.
 * The error names the variable but never prints its value.
 */
function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing required environment variable ${name}. ` +
        `Copy .env.example to .env.local and fill it in.`,
    );
  }
  return value;
}

/**
 * The shared Supabase client, created on first use (not at import time) so
 * that importing this module in a test or a build step needs no env vars.
 */
export function getSupabaseClient(): SupabaseClient {
  if (client) return client;

  const url = requireEnv('SUPABASE_URL');
  const serviceRoleKey = requireEnv('SUPABASE_SERVICE_ROLE_KEY');

  client = createClient(url, serviceRoleKey, {
    auth: {
      // No browser here: nothing to persist and no session to refresh.
      persistSession: false,
      autoRefreshToken: false,
    },
  });

  return client;
}

export class SupabaseOrderRepository implements OrderRepository {
  private readonly db: SupabaseClient;

  constructor(db: SupabaseClient = getSupabaseClient()) {
    this.db = db;
  }

  /**
   * One order by id, or null if there is no such order.
   * Does NOT filter by customer - the caller applies gate G3.
   */
  async getOrder(orderId: string): Promise<Order | null> {
    const { data, error } = await this.db
      .from('orders')
      .select(ORDER_COLUMNS)
      .eq('id', orderId)
      .maybeSingle<OrderRow>();

    if (error) throw error;
    return data ? toOrder(data) : null;
  }

  /** The customer's most recent order by created_at, any status. */
  async getLatestOrder(customerId: string): Promise<Order | null> {
    const { data, error } = await this.db
      .from('orders')
      .select(ORDER_COLUMNS)
      .eq('customer_id', customerId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle<OrderRow>();

    if (error) throw error;
    return data ? toOrder(data) : null;
  }

  /** The customer's cancellable orders - status 'processing' only - oldest first. */
  async getCancellableOrders(customerId: string): Promise<Order[]> {
    const { data, error } = await this.db
      .from('orders')
      .select(ORDER_COLUMNS)
      .eq('customer_id', customerId)
      .eq('status', 'processing')
      .order('created_at', { ascending: true })
      .returns<OrderRow[]>();

    if (error) throw error;
    return (data ?? []).map(toOrder);
  }

  /**
   * Cancel one order with a SINGLE conditional update: 'processing' is part of
   * the WHERE clause, so an order that changed in the meantime cannot be
   * cancelled. Exactly one updated row means success.
   *
   * Only on failure do we read the order back, purely to say which reason it
   * was - that read never changes the outcome of the update above.
   */
  async cancelOrder(orderId: string): Promise<CancelResult> {
    const { data, error } = await this.db
      .from('orders')
      .update({ status: 'cancelled' })
      .eq('id', orderId)
      .eq('status', 'processing')
      .select('id')
      .returns<{ id: string }[]>();

    if (error) throw error;
    if ((data ?? []).length === 1) return { ok: true };

    const existing = await this.getOrder(orderId);
    return { ok: false, reason: existing ? 'not_cancellable' : 'not_found' };
  }
}

export class SupabaseSessionStore implements SessionStore {
  private readonly db: SupabaseClient;

  constructor(db: SupabaseClient = getSupabaseClient()) {
    this.db = db;
  }

  /**
   * Read the workflow state for a session, or idle when nothing is stored.
   * Also treats a row with no step (the schema's '{}' default) as idle, so a
   * half-written row cannot put the workflow in an unknown step.
   */
  async getState(sessionId: string): Promise<SessionState> {
    const { data, error } = await this.db
      .from('session_state')
      .select('state')
      .eq('session_id', sessionId)
      .maybeSingle<{ state: SessionState | null }>();

    if (error) throw error;
    return data?.state?.step ? data.state : idleState();
  }

  /** Upsert the state for a session, stamping updated_at. */
  async setState(sessionId: string, customerId: string, state: SessionState): Promise<void> {
    const { error } = await this.db.from('session_state').upsert(
      {
        session_id: sessionId,
        customer_id: customerId,
        state,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'session_id' },
    );

    if (error) throw error;
  }
}

export class SupabaseHandoffRepository implements HandoffRepository {
  private readonly db: SupabaseClient;

  constructor(db: SupabaseClient = getSupabaseClient()) {
    this.db = db;
  }

  /** Insert one handoff ticket. created_at is left to the column default. */
  async create(sessionId: string, customerId: string, message: string): Promise<void> {
    const { error } = await this.db.from('handoff_tickets').insert({
      session_id: sessionId,
      customer_id: customerId,
      message,
    });

    if (error) throw error;
  }
}
