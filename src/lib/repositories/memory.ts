// In-memory implementation of the repository interfaces, for tests and local runs.
// Seeded with the same demo orders as supabase/seed.sql.
// Every call to createMemoryRepositories() returns a fresh, isolated instance.

import type {
  CancelResult,
  HandoffRepository,
  Order,
  OrderRepository,
  Repositories,
  SessionState,
  SessionStore,
} from './types';
import { idleState } from './types';

/** A handoff ticket as stored in memory. Mirrors the handoff_tickets row. */
export type MemoryHandoffTicket = {
  sessionId: string;
  customerId: string;
  message: string;
  createdAt: string;
};

/**
 * The repositories plus test-only inspection. `handoffTickets` is deliberately
 * NOT part of the HandoffRepository interface - production code must not read it.
 */
export type MemoryRepositories = Repositories & {
  /** Tickets created so far, oldest first. For assertions in tests. */
  handoffTickets: MemoryHandoffTicket[];
};

const DAY_MS = 24 * 60 * 60 * 1000;

/** Demo orders, matching supabase/seed.sql: [id, customerId, status, itemSummary, daysAgo]. */
const SEED: ReadonlyArray<readonly [string, string, Order['status'], string, number]> = [
  ['1001', 'cust_001', 'delivered', 'Laptop stand', 30],
  ['1002', 'cust_001', 'shipped', 'USB-C cable', 6],
  ['1003', 'cust_001', 'processing', 'Phone case', 8],
  ['1004', 'cust_001', 'cancelled', 'Desk lamp', 12],
  ['1005', 'cust_001', 'processing', 'Wireless headphones', 5],
  // 1006 repeats 1005's item name on purpose, to exercise label disambiguation
  ['1006', 'cust_001', 'processing', 'Wireless headphones', 2],
  ['2001', 'cust_002', 'processing', 'Yoga mat', 3],
  ['2002', 'cust_002', 'shipped', 'Water bottle', 9],
];

function seedOrders(): Order[] {
  const now = Date.now();
  return SEED.map(([id, customerId, status, itemSummary, daysAgo]) => ({
    id,
    customerId,
    status,
    itemSummary,
    createdAt: new Date(now - daysAgo * DAY_MS).toISOString(),
  }));
}

/**
 * Build a fresh set of in-memory repositories, seeded with the demo orders.
 * Nothing is shared between instances, so tests cannot leak state into each other.
 */
export function createMemoryRepositories(): MemoryRepositories {
  const orders = seedOrders();
  const sessions = new Map<string, { customerId: string; state: SessionState }>();
  const handoffTickets: MemoryHandoffTicket[] = [];

  // Hand out copies so callers cannot mutate our stored rows by accident.
  const copy = (order: Order): Order => ({ ...order });

  const orderRepository: OrderRepository = {
    async getOrder(orderId: string): Promise<Order | null> {
      const found = orders.find((order) => order.id === orderId);
      return found ? copy(found) : null;
    },

    async getLatestOrder(customerId: string): Promise<Order | null> {
      const mine = orders.filter((order) => order.customerId === customerId);
      if (mine.length === 0) return null;
      const latest = mine.reduce((a, b) => (a.createdAt >= b.createdAt ? a : b));
      return copy(latest);
    },

    async getCancellableOrders(customerId: string): Promise<Order[]> {
      return orders
        .filter((order) => order.customerId === customerId && order.status === 'processing')
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        .map(copy);
    },

    async cancelOrder(orderId: string): Promise<CancelResult> {
      const found = orders.find((order) => order.id === orderId);
      if (!found) return { ok: false, reason: 'not_found' };
      if (found.status !== 'processing') return { ok: false, reason: 'not_cancellable' };
      found.status = 'cancelled';
      return { ok: true };
    },
  };

  const sessionStore: SessionStore = {
    async getState(sessionId: string): Promise<SessionState> {
      const stored = sessions.get(sessionId);
      return stored ? { ...stored.state } : idleState();
    },

    async setState(sessionId: string, customerId: string, state: SessionState): Promise<void> {
      sessions.set(sessionId, { customerId, state: { ...state } });
    },
  };

  const handoffRepository: HandoffRepository = {
    async create(sessionId: string, customerId: string, message: string): Promise<void> {
      handoffTickets.push({
        sessionId,
        customerId,
        message,
        createdAt: new Date().toISOString(),
      });
    },
  };

  return {
    orders: orderRepository,
    sessions: sessionStore,
    handoffs: handoffRepository,
    handoffTickets,
  };
}
