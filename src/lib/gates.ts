// The checks the CODE performs. Pure functions: no I/O, no LLM, no state.
// These are the rules the model is never trusted with - see CLAUDE.md.
//
// G2 (order exists) is not here: it needs a repository, so it is applied where
// the repository is available. When it fails it MUST reply with
// ORDER_NOT_FOUND_MESSAGE, the same text G3 uses.

import { MAX_MESSAGE_LENGTH } from './config';
import type { ConfirmationReply } from './schema';
import type { Order } from './repositories/types';

export type GateResult =
  | { ok: true }
  | {
      ok: false;
      /** Machine-readable cause, for logs and branching. Never shown to the customer. */
      reason: string;
      /** Short English text for the customer. The LLM phrases/translates it. */
      userMessage: string;
    };

const ok: GateResult = { ok: true };

function fail(reason: string, userMessage: string): GateResult {
  return { ok: false, reason, userMessage };
}

/**
 * The single reply used both when an order does not exist (G2) and when it
 * belongs to someone else (G3).
 *
 * Using one string is the point: a customer must not be able to tell those two
 * cases apart, or they could discover which order numbers are real.
 */
export const ORDER_NOT_FOUND_MESSAGE = "I could not find that order.";

/** Exactly four ASCII digits. \d is ASCII-only in JS, so Arabic-Indic digits fail. */
const ORDER_ID_PATTERN = /^\d{4}$/;

/**
 * G1: the order id is exactly 4 digits.
 *
 * Strict - the id is not trimmed or normalised first, so " 1002 " fails. We
 * check what the model actually produced rather than quietly repairing it.
 */
export function gateOrderIdFormat(id: string): GateResult {
  if (!ORDER_ID_PATTERN.test(id)) {
    return fail('order_id_format', 'Order numbers are four digits, like 1002.');
  }
  return ok;
}

/**
 * G3: the order belongs to this customer.
 *
 * On failure the customer sees exactly the "not found" message - the reason
 * differs only in the logs.
 */
export function gateOrderBelongsToCustomer(order: Order, customerId: string): GateResult {
  if (order.customerId !== customerId) {
    return fail('order_other_customer', ORDER_NOT_FOUND_MESSAGE);
  }
  return ok;
}

/** G4: only an order still being processed can be cancelled. */
export function gateOrderCancellable(order: Order): GateResult {
  switch (order.status) {
    case 'processing':
      return ok;
    case 'shipped':
      return fail(
        'order_not_cancellable',
        'That order has already shipped, so it can no longer be cancelled.',
      );
    case 'delivered':
      return fail(
        'order_not_cancellable',
        'That order has already been delivered, so it can no longer be cancelled.',
      );
    case 'cancelled':
      return fail('order_already_cancelled', 'That order is already cancelled.');
  }
}

/** G5: the chosen option number is an integer within 1..count. */
export function gateChoiceInRange(choice: number | null, count: number): GateResult {
  if (choice === null || !Number.isInteger(choice) || choice < 1 || choice > count) {
    return fail('choice_out_of_range', 'Please reply with the number of the order you mean.');
  }
  return ok;
}

/** G6: only an explicit yes counts as confirmation. */
export function gateConfirmed(reply: ConfirmationReply['reply']): GateResult {
  if (reply === 'yes') return ok;

  if (reply === 'no') {
    return fail('declined', 'Nothing was cancelled.');
  }
  return fail('not_confirmed', 'I need a clear yes before cancelling. Nothing was cancelled.');
}

/** G9: the incoming request is usable at all. */
export function gateMessage(message: string, sessionId: string): GateResult {
  if (sessionId.trim().length === 0) {
    return fail('missing_session', 'Something went wrong. Please start a new conversation.');
  }
  if (message.trim().length === 0) {
    return fail('empty_message', 'Please type your question.');
  }
  if (message.length > MAX_MESSAGE_LENGTH) {
    return fail(
      'message_too_long',
      `That message is too long. Please keep it under ${String(MAX_MESSAGE_LENGTH)} characters.`,
    );
  }
  return ok;
}
