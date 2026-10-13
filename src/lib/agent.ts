// Agent loop: takes a user message, calls the LLM with tools, returns a reply.
// This is the workflow entry point. The CODE decides and routes; the LLM only
// classifies and phrases.
//
// SKELETON: every intent currently answers "not implemented yet". The state is
// loaded and logged but never written and never branched on.

import { DEMO_CUSTOMER_ID } from './config';
import { gateMessage } from './gates';
import { classifyIntent, writeReply } from './llm';
import { logInfo } from './logger';
import { getRepositories } from './repositories';
import type { Order, Repositories } from './repositories/types';
import { type ChatResponse, ChatResponseSchema, type Intent } from './schema';
import { lookupOrder } from './tools';

/**
 * Everything handleMessage talks to. Tests pass in-memory repositories and
 * fake llm functions; production passes nothing and gets the real ones.
 */
export type Deps = {
  repos: Repositories;
  llm: {
    classifyIntent: typeof classifyIntent;
    writeReply: typeof writeReply;
  };
};

/** A response that says nothing happened, with the right intent attached. */
function notImplemented(intent: Intent): ChatResponse {
  return {
    answer: `That part of this assistant is not implemented yet (${intent}).`,
    intent,
    needsConfirmation: false,
    options: [],
    offerHandoff: false,
    sources: [],
  };
}

/** A safe reply for a request we refuse before doing any work (gate G9). */
function refusal(userMessage: string): ChatResponse {
  return {
    answer: userMessage,
    intent: 'out_of_scope',
    needsConfirmation: false,
    options: [],
    offerHandoff: false,
    sources: [],
  };
}

/** Told to the model when the customer gave no order number. */
const MOST_RECENT_ORDER_FACT =
  "This is the customer's most recent order. They did not give an order number. " +
  'Invite them to send a 4-digit order number if they meant a different order.';

/** Told to the model when the customer has never ordered anything. */
const NO_ORDERS_FACT = 'The customer has no orders at all.';

/**
 * The facts about one order the model is allowed to use.
 *
 * The date is the UTC date part of createdAt, so it does not shift with the
 * machine's timezone or locale. The model phrases it for the customer.
 */
function orderFacts(order: Order): string {
  return [
    `Order ${order.id}.`,
    `Item: ${order.itemSummary}.`,
    `Status: ${order.status}.`,
    `Ordered on: ${order.createdAt.slice(0, 10)}.`,
  ].join('\n');
}

/**
 * Gate G7 on the way out: nothing leaves this function unless it matches the
 * response schema. A failure here is our bug, not the model's, so it throws.
 */
function validateResponse(response: ChatResponse): ChatResponse {
  const parsed = ChatResponseSchema.safeParse(response);
  if (!parsed.success) {
    throw new Error(
      `handleMessage produced a response that failed gate G7: ${parsed.error.message}`,
    );
  }
  return parsed.data;
}

type OrderLookupArgs = {
  message: string;
  /** The id the classifier extracted, or null if the customer gave none. */
  orderId: string | null;
  customerId: string;
  repos: Repositories;
  llm: Deps['llm'];
};

/**
 * The order lookup flow. Reads only; never writes and never changes the state.
 *
 * Two paths, and the split is deliberate: an orderId that is PRESENT always
 * goes through lookupOrder, even when it is malformed. A bad order number must
 * never silently fall back to "here is your most recent order" - the customer
 * asked about a specific order and has to be told that number was no good.
 */
async function handleOrderLookup({
  message,
  orderId,
  customerId,
  repos,
  llm,
}: OrderLookupArgs): Promise<ChatResponse> {
  let facts: string;

  if (orderId === null || orderId.trim() === '') {
    const latest = await repos.orders.getLatestOrder(customerId);
    facts =
      latest === null ? NO_ORDERS_FACT : [orderFacts(latest), MOST_RECENT_ORDER_FACT].join('\n');
  } else {
    // Applies G1, then G2, then G3. A failure gives us only its userMessage,
    // so nothing about another customer's order can reach the model.
    const result = await lookupOrder({ orderId, customerId, orders: repos.orders });
    facts = result.ok ? orderFacts(result.order) : result.userMessage;
  }

  const answer = await llm.writeReply({ intent: 'order_lookup', facts, customerMessage: message });

  return {
    answer,
    intent: 'order_lookup',
    needsConfirmation: false,
    options: [],
    offerHandoff: false,
    sources: [],
  };
}

/**
 * Handle one customer message.
 *
 * Never throws for bad input: an unusable request comes back as a normal
 * structured response (gate G9).
 */
export async function handleMessage(
  sessionId: string,
  message: string,
  deps?: Partial<Deps>,
): Promise<ChatResponse> {
  // G9 first, before any I/O or LLM call.
  const usable = gateMessage(message, sessionId);
  if (!usable.ok) {
    logInfo('G9 rejected the request', { reason: usable.reason });
    return validateResponse(refusal(usable.userMessage));
  }

  // `??` keeps these lazy: a test that injects repos never builds the real
  // Supabase client, so no env vars are needed.
  const repos = deps?.repos ?? getRepositories();
  const llm = deps?.llm ?? { classifyIntent, writeReply };
  const customerId = DEMO_CUSTOMER_ID;

  const state = await repos.sessions.getState(sessionId);
  logInfo('loaded session state', { sessionId, customerId, state });

  const classification = await llm.classifyIntent({
    message,
    handoffOffered: state.handoffOffered ?? false,
  });

  // Exhaustive on purpose: when a flow is implemented it replaces its case
  // here, and a new intent would be a compile error rather than a silent gap.
  switch (classification.intent) {
    case 'policy_question':
      return validateResponse(notImplemented('policy_question'));
    case 'order_lookup':
      return validateResponse(
        await handleOrderLookup({
          message,
          orderId: classification.orderId,
          customerId,
          repos,
          llm,
        }),
      );
    case 'cancel_order':
      return validateResponse(notImplemented('cancel_order'));
    case 'human_handoff':
      return validateResponse(notImplemented('human_handoff'));
    case 'out_of_scope':
      return validateResponse(notImplemented('out_of_scope'));
  }
}
