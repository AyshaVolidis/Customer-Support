// Agent loop: takes a user message, calls the LLM with tools, returns a reply.
// This is the workflow entry point. The CODE decides and routes; the LLM only
// classifies and phrases.
//
// PARTLY BUILT: order_lookup is implemented. The pending-reply branch routes a
// reply to our own question away from intent classification, but continuing a
// cancel flow still answers "not implemented yet", as do the other intents.

import { buildCandidateOrders, labelsForLlm, toOptions } from './cancelHelpers';
import { DEMO_CUSTOMER_ID } from './config';
import { gateMessage, gateOrderCancellable } from './gates';
import { classifyIntent, classifyPendingReply, writeReply } from './llm';
import { logInfo } from './logger';
import { getRepositories } from './repositories';
import type { Order, Repositories, SessionState } from './repositories/types';
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
    classifyPendingReply: typeof classifyPendingReply;
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

/**
 * The reply when the customer answered our own pending question.
 *
 * Placeholder: the cancel steps that continue the flow are not built yet.
 */
function pendingFlowNotImplemented(): ChatResponse {
  return {
    answer: 'Thanks - continuing that request is not implemented yet.',
    intent: 'cancel_order',
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
  "This is the customer's most recent order. They did not give an order number. ";

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

type CancelWithIdArgs = {
  sessionId: string;
  message: string;
  /** The id the classifier extracted. Not trusted: G1 checks it first. */
  orderId: string;
  customerId: string;
  repos: Repositories;
  llm: Deps['llm'];
};

/** A cancel_order reply. Only the flag and the options vary. */
function cancelResponse(
  answer: string,
  needsConfirmation: boolean,
  options: ChatResponse['options'] = [],
): ChatResponse {
  return {
    answer,
    intent: 'cancel_order',
    needsConfirmation,
    options,
    offerHandoff: false,
    sources: [],
  };
}

type CancelWithoutIdArgs = {
  sessionId: string;
  message: string;
  customerId: string;
  repos: Repositories;
  llm: Deps['llm'];
};

/** Told to the model when there is nothing the customer could cancel. */
const NOTHING_TO_CANCEL_FACT =
  'The customer has no orders that can be cancelled right now. ';

/**
 * Cancel flow, the other opening: the customer did not name an order.
 *
 * Offers the cancellable orders as a NUMBERED list. The model is given the
 * labels only - the real ids stay in the state and in the code, so the model
 * cannot invent or leak one, and the customer's answer is just a number.
 */
async function handleCancelWithoutOrderId({
  sessionId,
  message,
  customerId,
  repos,
  llm,
}: CancelWithoutIdArgs): Promise<ChatResponse> {
  // Only 'processing' orders come back, oldest first (G4 by construction).
  const cancellable = await repos.orders.getCancellableOrders(customerId);

  if (cancellable.length === 0) {
    logInfo('cancel: nothing to offer', { customerId });
    return cancelResponse(
      await llm.writeReply({
        intent: 'cancel_order',
        facts: NOTHING_TO_CANCEL_FACT,
        customerMessage: message,
      }),
      false,
    );
  }

  const candidates = buildCandidateOrders(cancellable);

  // Built from scratch: nothing from an earlier turn survives into this flow.
  const next: SessionState = {
    step: 'awaiting_order_selection',
    candidateOrders: candidates,
    retries: 0,
  };
  await repos.sessions.setState(sessionId, customerId, next);

  // labelsForLlm is numbers and labels only - never an order id.
  const facts = [
    'These are the orders the customer can still cancel:',
    labelsForLlm(candidates),
    'Ask which one they mean and tell them to reply with its number.',
    'Nothing has been cancelled yet.',
  ].join('\n');

  return cancelResponse(
    await llm.writeReply({ intent: 'cancel_order', facts, customerMessage: message }),
    false,
    toOptions(candidates),
  );
}

/**
 * Cancel flow, first half: the customer named an order.
 *
 * Gates in order: G1 and G2 and G3 via lookupOrder, then G4. Nothing is
 * cancelled here - this only asks the confirmation question. cancelOrder is
 * called later, after an explicit yes (G6) and a re-check of G1-G4.
 */
async function handleCancelWithOrderId({
  sessionId,
  message,
  orderId,
  customerId,
  repos,
  llm,
}: CancelWithIdArgs): Promise<ChatResponse> {
  // G1 (format), G2 (exists), G3 (ownership). A failure hands back only a
  // userMessage, and "missing" and "not yours" are the same message, so the
  // customer cannot tell another customer's order from a made-up number.
  const found = await lookupOrder({ orderId, customerId, orders: repos.orders });

  if (!found.ok) {
    logInfo('cancel refused', { reason: found.reason });
    return cancelResponse(
      await llm.writeReply({
        intent: 'cancel_order',
        facts: found.userMessage,
        customerMessage: message,
      }),
      false,
    );
  }

  // G4: only an order still being processed can be cancelled.
  const cancellable = gateOrderCancellable(found.order);

  if (!cancellable.ok) {
    logInfo('cancel refused', { reason: cancellable.reason, orderId: found.order.id });
    return cancelResponse(
      await llm.writeReply({
        intent: 'cancel_order',
        facts: cancellable.userMessage,
        customerMessage: message,
      }),
      false,
    );
  }

  // Built from scratch, never spread, so no handoffOffered, problemText or
  // candidateOrders from an earlier turn survive into this flow.
  const next: SessionState = {
    step: 'awaiting_confirmation',
    selectedOrderId: found.order.id,
    retries: 0,
  };
  await repos.sessions.setState(sessionId, customerId, next);

  // The customer supplied this id, so repeating it back is safe and useful.
  const facts = [
    `Ask the customer to confirm this cancellation, and nothing else: like Do you want`,
    `Cancel order ${found.order.id} (${found.order.itemSummary})?`,
    `Nothing has been cancelled yet.`,
  ].join('\n');

  return cancelResponse(
    await llm.writeReply({ intent: 'cancel_order', facts, customerMessage: message }),
    true,
  );
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
  const llm = deps?.llm ?? { classifyIntent, classifyPendingReply, writeReply };
  const customerId = DEMO_CUSTOMER_ID;

  const stored = await repos.sessions.getState(sessionId);
  logInfo('loaded session state', { sessionId, customerId, state: stored });

  // The state the rest of this turn works from. It only differs from `stored`
  // when a pending flow was abandoned below.
  let state = stored;

  if (stored.step !== 'idle') {
    // We are waiting on an answer, so ask that question BEFORE classifying the
    // intent: "yes" or "the second one" means nothing without the question.
    const pending = await llm.classifyPendingReply({ message, state: stored });
    logInfo('classified a pending reply', { step: stored.step, kind: pending.kind });

    if (pending.kind === 'answer_to_pending') {
      // Leave the stored state exactly as it is: the step that continues this
      // flow owns it, and it is not built yet.
      return validateResponse(pendingFlowNotImplemented());
    }

    // new_topic: abandon the flow. Built from scratch, never spread, so no
    // candidateOrders, selectedOrderId, retries or handoffOffered survive.
    const reset: SessionState = { step: 'idle' };
    await repos.sessions.setState(sessionId, customerId, reset);
    state = reset;
  }

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
    case 'cancel_order': {
      const requested = classification.orderId;

      // No order number given: offer the cancellable orders as a numbered list.
      if (requested === null || requested.trim() === '') {
        return validateResponse(
          await handleCancelWithoutOrderId({ sessionId, message, customerId, repos, llm }),
        );
      }

      return validateResponse(
        await handleCancelWithOrderId({
          sessionId,
          message,
          orderId: requested,
          customerId,
          repos,
          llm,
        }),
      );
    }
    case 'human_handoff':
      return validateResponse(notImplemented('human_handoff'));
    case 'out_of_scope':
      return validateResponse(notImplemented('out_of_scope'));
  }
}
