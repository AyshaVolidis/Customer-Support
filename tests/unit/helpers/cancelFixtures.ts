// Shared fixtures for the cancel-flow tests. No tests live in this file.
//
// ---------------------------------------------------------------------------
// THE CONTRACT EVERY CANCEL TEST USES
// ---------------------------------------------------------------------------
//
// Calling convention:
//
//   const repos = createMemoryRepositories();
//   const { llm } = makeLlm({ ... });
//   await handleMessage(SESSION, 'cancel my order', { repos, llm });
//
// The four llm functions and what they resolve to:
//
//   classifyIntent({ message, handoffOffered })
//     -> { intent, orderId, wantsHuman, isComplaint }
//   classifyPendingReply({ message, state })
//     -> { kind: 'answer_to_pending' | 'new_topic' }
//   interpretOrderSelection(...)
//     -> { kind: 'choose' | 'unclear' | 'back_out', choice: number | null }
//   interpretConfirmation(...)
//     -> 'yes' | 'no'   (binary: an unclear reply counts as 'no' - design Q8)
//
// writeReply({ intent, facts, customerMessage }) resolves to the string
// `FACTS: ${facts}` - the facts verbatim after that prefix. So a test can
// assert on exactly what the CODE decided to tell the model:
//
//   expect(response.answer).toBe('FACTS: Order 1005 was cancelled.');
//   expect(response.answer).toContain('already shipped');
//
// The two session states the cancel flow uses:
//
//   { step: 'awaiting_order_selection', candidateOrders: [...], retries: 0 }
//   { step: 'awaiting_confirmation', selectedOrderId: '1005', retries: 0 }
//
// Put one in place before calling handleMessage:
//
//   await repos.sessions.setState(SESSION, CUSTOMER, await awaitingSelection(repos));
//
// NOTE: interpretOrderSelection and interpretConfirmation do not exist in
// src/lib/llm.ts yet, and Deps['llm'] does not list them. That is why `llm` is
// returned with its type inferred rather than annotated as Deps['llm'].

import { vi } from 'vitest';

import { buildCandidateOrders } from '../../../src/lib/cancelHelpers';
import type { WriteReplyInput } from '../../../src/lib/llm';
import type {
  OrderStatus,
  Repositories,
  SessionState,
} from '../../../src/lib/repositories/types';
import type {
  ConfirmationReply,
  IntentClassification,
  OrderSelection,
  PendingReplyClassification,
} from '../../../src/lib/schema';

export const SESSION = 's-cancel';
export const CUSTOMER = 'cust_001';

export type MakeLlmOptions = {
  /** What classifyIntent reports. Defaults to 'out_of_scope'. */
  intent?: IntentClassification['intent'];
  /** The order id classifyIntent extracted. Defaults to null. */
  orderId?: string | null;
  /** What classifyPendingReply reports. Defaults to 'answer_to_pending'. */
  pending?: PendingReplyClassification['kind'];
  /** What interpretOrderSelection reports. Defaults to choosing option 2. */
  selection?: OrderSelection;
  /** What interpretConfirmation reports. Defaults to 'yes'. */
  confirmation?: ConfirmationReply['reply'];
};

/**
 * A fake llm whose answers are fixed up front.
 *
 * Every function is a vi.fn, so a test can override one turn at a time with
 * `llm.interpretConfirmation.mockResolvedValueOnce('no')` for multi-turn
 * scenarios, and inspect `llm.interpretOrderSelection.mock.calls` to prove no
 * order id was ever handed to the model.
 */
export function makeLlm(options: MakeLlmOptions = {}) {
  const classification: IntentClassification = {
    intent: options.intent ?? 'out_of_scope',
    orderId: options.orderId ?? null,
    wantsHuman: false,
    isComplaint: false,
  };

  const pending: PendingReplyClassification = {
    kind: options.pending ?? 'answer_to_pending',
  };

  const selection: OrderSelection = options.selection ?? { kind: 'choose', choice: 2 };
  const confirmation: ConfirmationReply['reply'] = options.confirmation ?? 'yes';

  // Each mock declares its argument so a test can read mock.calls[0][0] with a
  // type. `void input` marks it as deliberately unused by the fake itself.
  const llm = {
    classifyIntent: vi.fn((input: unknown): Promise<IntentClassification> => {
      void input;
      return Promise.resolve(classification);
    }),

    classifyPendingReply: vi.fn((input: unknown): Promise<PendingReplyClassification> => {
      void input;
      return Promise.resolve(pending);
    }),

    interpretOrderSelection: vi.fn((input: unknown): Promise<OrderSelection> => {
      void input;
      return Promise.resolve(selection);
    }),

    interpretConfirmation: vi.fn((input: unknown): Promise<ConfirmationReply['reply']> => {
      void input;
      return Promise.resolve(confirmation);
    }),

    // Returns the facts verbatim, so tests assert on what the code decided to
    // say rather than on wording a real model would have chosen.
    writeReply: vi.fn((input: WriteReplyInput): Promise<string> => {
      return Promise.resolve(`FACTS: ${input.facts}`);
    }),
  };

  return { llm };
}

/**
 * The state after we have offered the cancellable orders.
 *
 * Candidates are built from the repository, so the ids and labels match the
 * seed data instead of being hard-coded here.
 */
export async function awaitingSelection(repos: Repositories): Promise<SessionState> {
  const cancellable = await repos.orders.getCancellableOrders(CUSTOMER);

  return {
    step: 'awaiting_order_selection',
    candidateOrders: buildCandidateOrders(cancellable),
    retries: 0,
  };
}

/** The state after the customer has picked an order and we asked to confirm. */
export function awaitingConfirmation(orderId = '1005'): SessionState {
  return {
    step: 'awaiting_confirmation',
    selectedOrderId: orderId,
    retries: 0,
  };
}

/** Watch cancelOrder without changing what it does. */
export function spyCancel(repos: Repositories) {
  return vi.spyOn(repos.orders, 'cancelOrder');
}

/** The current status of one order, or null if there is no such order. */
export async function statusOf(repos: Repositories, orderId: string): Promise<OrderStatus | null> {
  const order = await repos.orders.getOrder(orderId);
  return order?.status ?? null;
}

/**
 * True if any of these order ids appears anywhere in `value`.
 *
 * Used to prove the model never receives a real order id: pass the whole
 * mock.calls array, not just one field.
 */
export function containsAnyOrderId(value: unknown, ids: string[]): boolean {
  const serialised = JSON.stringify(value) ?? '';
  return ids.some((id) => serialised.includes(id));
}
