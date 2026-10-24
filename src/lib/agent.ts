// Agent loop: takes a user message, calls the LLM with tools, returns a reply.
// This is the workflow entry point. The CODE decides and routes; the LLM only
// classifies and phrases.
//
// PARTLY BUILT: order_lookup is implemented. The pending-reply branch routes a
// reply to our own question away from intent classification, but continuing a
// cancel flow still answers "not implemented yet", as do the other intents.

import { buildCandidateOrders, labelsForLlm, resolveChoice, toOptions } from './cancelHelpers';
import { DEMO_CUSTOMER_ID, MAX_RETRIES } from './config';
import { gateConfirmed, gateMessage, gateOrderCancellable } from './gates';
import {
  classifyIntent,
  classifyPendingReply,
  interpretConfirmation,
  interpretOrderSelection,
  writeOutOfScopeReply,
  writeReply,
} from './llm';
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
    interpretOrderSelection: typeof interpretOrderSelection;
    interpretConfirmation: typeof interpretConfirmation;
    writeOutOfScopeReply: typeof writeOutOfScopeReply;
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
    'Ask which one they mean and tell them to choose from the list.',
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

/** Told to the model when the customer backs out of cancelling. */
const BACKED_OUT_FACT =
  'The customer no longer wants to cancel an order. Nothing will be cancelled. ' +
  'Acknowledge that briefly.';

/** Told to the model after too many unclear answers to the same question. */
const GAVE_UP_FACT =
  'We could not tell which order the customer meant. Nothing has been cancelled. ' +
  'Apologise briefly and invite them to start again with the order number.';

/** The question we put to the customer once one order is  selected. */
function confirmationFacts(order: Order): string {
  return [
    'Ask the customer to confirm this cancellation, and nothing else:',
    `Cancel order ${order.id} (${order.itemSummary})?`,
    'Nothing has been cancelled yet.',
  ].join('\n');
}

/** Told to the model when the repository refused the cancellation. */
const CANCEL_FAILED_FACT =
  'The cancellation did not go through, and the order has not changed. ' +
  'Apologise briefly and suggest they try again in a moment. ' +
  'Do NOT tell them the order is cancelled.';

/** Told to the model when we no longer know which order was being confirmed. */
const LOST_SELECTION_FACT =
  'We lost track of which order was being cancelled. Nothing has been cancelled. ' +
  'Apologise briefly and ask them to start again with the cancelled order number.';

type BackToIdleArgs = {
  sessionId: string;
  message: string;
  facts: string;
  customerId: string;
  repos: Repositories;
  llm: Deps['llm'];
};

/**
 * End a cancel flow: store a fresh idle state, then reply from the facts.
 *
 * The state is built from scratch, so nothing from the abandoned flow - a
 * selection, a candidate list, a retry count - can survive.
 */
async function cancelBackToIdle({
  sessionId,
  message,
  facts,
  customerId,
  repos,
  llm,
}: BackToIdleArgs): Promise<ChatResponse> {
  await repos.sessions.setState(sessionId, customerId, { step: 'idle' });
  return cancelResponse(
    await llm.writeReply({ intent: 'cancel_order', facts, customerMessage: message }),
    false,
  );
}

type OrderSelectionArgs = {
  sessionId: string;
  message: string;
  /** The stored state. candidateOrders here is the ONLY source of real ids. */
  state: SessionState;
  customerId: string;
  repos: Repositories;
  llm: Deps['llm'];
};

/**
 * Cancel flow, middle: the customer is answering "which order?".
 *
 * The model is shown numbers and labels and returns a number. The real id is
 * then taken from the STORED candidate list - never from the model - and the
 * order is re-fetched and re-checked, because it may have shipped or changed
 * hands since we built the list.
 */
async function handleOrderSelection({
  sessionId,
  message,
  state,
  customerId,
  repos,
  llm,
}: OrderSelectionArgs): Promise<ChatResponse> {
  const candidates = state.candidateOrders ?? [];
  const selection = await llm.interpretOrderSelection({
    message,
    labels: labelsForLlm(candidates),
  });

  const backToIdle = (facts: string): Promise<ChatResponse> =>
    cancelBackToIdle({ sessionId, message, facts, customerId, repos, llm });

  if (selection.kind === 'back_out') {
    logInfo('cancel: customer backed out', { sessionId });
    return backToIdle(BACKED_OUT_FACT);
  }

  // G5 lives inside resolveChoice: a number outside 1..N resolves to null, and
  // an unusable choice is treated exactly like an unclear reply.
  const chosen =
    selection.kind === 'choose' && selection.choice !== null
      ? resolveChoice(candidates, selection.choice)
      : null;

  if (chosen === null) {
    const retries = (state.retries ?? 0) + 1;

    if (retries > MAX_RETRIES) {
      logInfo('cancel: giving up on selection', { retries });
      return backToIdle(GAVE_UP_FACT);
    }

    logInfo('cancel: selection unclear, asking again', { retries });
    await repos.sessions.setState(sessionId, customerId, {
      step: 'awaiting_order_selection',
      candidateOrders: candidates,
      retries,
    });

    const facts = [
      'We could not tell which order the customer meant. Ask again, briefly.',
      'These are the orders they can cancel:',
      labelsForLlm(candidates),
      'Tell them to choose one.',
      'Nothing has been cancelled yet.',
    ].join('\n');

    return cancelResponse(
      await llm.writeReply({ intent: 'cancel_order', facts, customerMessage: message }),
      false,
      toOptions(candidates),
    );
  }

  // Re-check from scratch: the list could be minutes old.
  const found = await lookupOrder({ orderId: chosen.id, customerId, orders: repos.orders });

  if (!found.ok) {
    logInfo('cancel: chosen order failed a re-check', { reason: found.reason });
    return backToIdle(found.userMessage);
  }

  const cancellable = gateOrderCancellable(found.order);

  if (!cancellable.ok) {
    logInfo('cancel: chosen order is no longer cancellable', { reason: cancellable.reason });
    return backToIdle(cancellable.userMessage);
  }

  await repos.sessions.setState(sessionId, customerId, {
    step: 'awaiting_confirmation',
    selectedOrderId: found.order.id,
    retries: 0,
  });

  return cancelResponse(
    await llm.writeReply({
      intent: 'cancel_order',
      facts: confirmationFacts(found.order),
      customerMessage: message,
    }),
    true,
  );
}

type ConfirmationArgs = {
  sessionId: string;
  message: string;
  /** The stored state. selectedOrderId here is the ONLY id we will cancel. */
  state: SessionState;
  customerId: string;
  repos: Repositories;
  llm: Deps['llm'];
};

/**
 * Cancel flow, last step: the customer is answering "cancel order X?".
 *
 * THIS IS THE ONLY PLACE IN THE CODEBASE THAT CALLS cancelOrder.
 *
 * The order of operations is the whole safety story, so do not reorder it:
 *
 *   1. read the customer's reply (the model reports yes / no, and answers no
 *      whenever it is unsure - design Q8)
 *   2. G6 - only an explicit yes gets past this line
 *   3. re-fetch the order named by the STORED selectedOrderId
 *   4. re-check G1, G2, G3 (lookupOrder) and G4 - it may have shipped since
 *   5. only then cancel, and only the id from the state
 *
 * A model answer alone can never reach step 5, and a failed cancellation is
 * never reported as a success.
 */
async function handleConfirmation({
  sessionId,
  message,
  state,
  customerId,
  repos,
  llm,
}: ConfirmationArgs): Promise<ChatResponse> {
  const backToIdle = (facts: string): Promise<ChatResponse> =>
    cancelBackToIdle({ sessionId, message, facts, customerId, repos, llm });

  const reply = await llm.interpretConfirmation({ message });

  // G6: only an explicit yes gets past here. The reply is binary, so an
  // unclear message already arrived as 'no' - we never re-ask, and there is
  // no retry count for this step.
  const confirmed = gateConfirmed(reply);

  if (!confirmed.ok) {
    logInfo('cancel: not confirmed', { sessionId, reason: confirmed.reason });
    return backToIdle(confirmed.userMessage);
  }

  // From here on the id comes from the state, never from the model.
  const selectedOrderId = state.selectedOrderId;
  if (selectedOrderId === undefined) {
    logInfo('cancel: confirmed but no order selected', { sessionId });
    return backToIdle(LOST_SELECTION_FACT);
  }

  // Re-check G1, G2, G3 - the order may have changed hands or vanished.
  const found = await lookupOrder({ orderId: selectedOrderId, customerId, orders: repos.orders });

  if (!found.ok) {
    logInfo('cancel: confirmed order failed a re-check', { reason: found.reason });
    return backToIdle(found.userMessage);
  }

  // Re-check G4 - it may have shipped while we were asking.
  const cancellable = gateOrderCancellable(found.order);

  if (!cancellable.ok) {
    logInfo('cancel: confirmed order is no longer cancellable', { reason: cancellable.reason });
    return backToIdle(cancellable.userMessage);
  }

  const result = await repos.orders.cancelOrder(found.order.id);

  if (!result.ok) {
    logInfo('cancel: the repository refused', { reason: result.reason, orderId: found.order.id });
    return backToIdle(CANCEL_FAILED_FACT);
  }

  logInfo('cancel: order cancelled', { orderId: found.order.id });

  return backToIdle(
    [
      `Order ${found.order.id} (${found.order.itemSummary}) has been cancelled.`,
      'Confirm that to the customer in one short sentence.',
    ].join('\n'),
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
  const llm = deps?.llm ?? {
    classifyIntent,
    classifyPendingReply,
    interpretOrderSelection,
    interpretConfirmation,
    writeOutOfScopeReply,
    writeReply,
  };
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
      if (stored.step === 'awaiting_order_selection') {
        return validateResponse(
          await handleOrderSelection({
            sessionId,
            message,
            state: stored,
            customerId,
            repos,
            llm,
          }),
        );
      }

      return validateResponse(
        await handleConfirmation({
          sessionId,
          message,
          state: stored,
          customerId,
          repos,
          llm,
        }),
      );
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
      // Reads only the current message: there is no history to lean on, and
      // this branch touches no order and creates no ticket.
      return validateResponse({
        answer: await llm.writeOutOfScopeReply({ message }),
        intent: 'out_of_scope',
        needsConfirmation: false,
        options: [],
        offerHandoff: false,
        sources: [],
      });
  }
}
