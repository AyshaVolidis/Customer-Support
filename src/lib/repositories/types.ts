// Repository interfaces so the agent does not depend on a specific data store.
// Two implementations: supabase.ts (real) and memory.ts (tests).
// Types and interfaces only - no implementations beyond the idleState() helper.

/** Order status. Only 'processing' orders are cancellable (gate G4). */
export type OrderStatus = 'processing' | 'shipped' | 'delivered' | 'cancelled';

/** A customer order, as the rest of the code sees it. */
export type Order = {
  /** 4-digit order id, e.g. '1002' (the 4-digit rule is gate G1). */
  id: string;
  customerId: string;
  status: OrderStatus;
  itemSummary: string;
  /** ISO 8601 string, not a Date, so state and logs stay plain JSON. */
  createdAt: string;
};

/**
 * One option offered during order selection: a temporary number the LLM sees,
 * the real order id (code/state only, never sent to the LLM), and the label.
 */
export type CandidateOrder = {
  /** Temporary number 1..N, shown to the LLM instead of the real id. */
  n: number;
  /** The real order id. Never include this in a prompt. */
  id: string;
  /** Human label: item name + order date. */
  label: string;
};

/** Where the customer is in a flow. */
export type SessionStep = 'idle' | 'awaiting_order_selection' | 'awaiting_confirmation';

/**
 * The only memory the server keeps. No chat history.
 * Written by code only - the LLM never decides or writes this.
 */
export type SessionState = {
  step: SessionStep;
  /** Set while step is 'awaiting_order_selection'. */
  candidateOrders?: CandidateOrder[];
  /** Set while step is 'awaiting_confirmation'. */
  selectedOrderId?: string;
  /** Unclear replies in the current pending step. Reset to 0 on entering one. */
  retries?: number;
  /** True only if this turn offered a handoff; any other message clears it. */
  handoffOffered?: boolean;
  /** The complaint text stored when a handoff was offered; becomes the ticket message. */
  problemText?: string;
};

/** Result of a cancellation attempt. */
export type CancelResult =
  | { ok: true }
  | { ok: false; reason: 'not_found' | 'not_cancellable' };

export interface OrderRepository {
  /**
   * Look up one order by id, or null if no such order exists.
   * Does NOT filter by customer - the caller must apply gate G3 by comparing
   * customerId, and must answer identically for "not found" and "not yours".
   */
  getOrder(orderId: string): Promise<Order | null>;

  /**
   * The customer's most recent order by createdAt, any status (even cancelled).
   * Null if the customer has no orders.
   */
  getLatestOrder(customerId: string): Promise<Order | null>;

  /**
   * The customer's cancellable orders - status 'processing' only - oldest first.
   * Empty array if there are none. These are the only orders ever offered to
   * the LLM for selection.
   */
  getCancellableOrders(customerId: string): Promise<Order[]>;

  /**
   * Cancel one order. Called by code only, after an explicit confirmation
   * (gate G6) and a re-check of gates G1-G4. Never called by the LLM.
   */
  cancelOrder(orderId: string): Promise<CancelResult>;
}

export interface SessionStore {
  /**
   * Read the workflow state for a session.
   * Returns { step: 'idle' } when nothing is stored.
   */
  getState(sessionId: string): Promise<SessionState>;

  /** Upsert the workflow state for a session. */
  setState(sessionId: string, customerId: string, state: SessionState): Promise<void>;
}

export interface HandoffRepository {
  /** Create one handoff ticket. message is the customer's problem text. */
  create(sessionId: string, customerId: string, message: string): Promise<void>;
}

/** The repositories the agent is given, so tests can inject in-memory ones. */
export type Repositories = {
  orders: OrderRepository;
  sessions: SessionStore;
  handoffs: HandoffRepository;
};

/** A fresh idle state - the starting point, and where every flow returns to. */
export function idleState(): SessionState {
  return { step: 'idle' };
}
