// These are plain functions the CODE calls. They are NOT exposed to the LLM as
// callable tools - the code decides when to run them.

import { ORDER_NOT_FOUND_MESSAGE, gateOrderBelongsToCustomer, gateOrderIdFormat } from './gates';
import type { Order, OrderRepository } from './repositories/types';

export type LookupOrderInput = {
  /** The order id as the customer gave it. Not trusted: G1 checks the format. */
  orderId: string;
  /** Whose orders we are allowed to see. */
  customerId: string;
  orders: OrderRepository;
};

export type LookupOrderResult =
  | { ok: true; order: Order }
  | { ok: false; reason: string; userMessage: string };

/**
 * The one result used for BOTH "no such order" (G2) and "not your order" (G3).
 *
 * Same reason, same message. If these differed in any way - even in a reason
 * that only reaches the logs - the difference could leak back to the customer
 * and let them probe which order numbers exist.
 */
function orderNotFound(): LookupOrderResult {
  return { ok: false, reason: 'order_not_found', userMessage: ORDER_NOT_FOUND_MESSAGE };
}

/**
 * Look up one order for one customer, applying G1, G2 and G3 in that order.
 *
 * Works for an order in any status - a lookup is not a cancellation, so G4 is
 * not applied here.
 */
export async function lookupOrder({
  orderId,
  customerId,
  orders,
}: LookupOrderInput): Promise<LookupOrderResult> {
  // G1: format. Checked before any I/O, so a malformed id never hits the database.
  const format = gateOrderIdFormat(orderId);
  if (!format.ok) {
    return { ok: false, reason: format.reason, userMessage: format.userMessage };
  }

  // G2: exists.
  const order = await orders.getOrder(orderId);
  if (!order) {
    return orderNotFound();
  }

  // G3: belongs to this customer - answered exactly like G2.
  const ownership = gateOrderBelongsToCustomer(order, customerId);
  if (!ownership.ok) {
    return orderNotFound();
  }

  return { ok: true, order };
}
