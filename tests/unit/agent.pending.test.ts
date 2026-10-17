// TDD (red): the pending-reply branch of handleMessage does not exist yet.
//
// Expected behaviour, once built:
//   state.step === 'idle'  -> classifyIntent, as today.
//   otherwise              -> classifyPendingReply FIRST, then
//     'new_topic'          -> reset the stored state to { step: 'idle' },
//                             then classifyIntent and route normally.
//     'answer_to_pending'  -> a placeholder cancel_order response, and the
//                             stored state is left exactly as it was.
//
// In-memory repositories and a fake llm: no network, no env vars.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Relative imports on purpose: the "@/*" alias is a tsconfig path that Vitest
// does not resolve without extra config.
import { handleMessage } from '../../src/lib/agent';
import { createMemoryRepositories } from '../../src/lib/repositories/memory';
import type { CandidateOrder, SessionState } from '../../src/lib/repositories/types';
import { ChatResponseSchema, type IntentClassification } from '../../src/lib/schema';
import { writeReply } from '@/lib/llm';

const SESSION = 'session-a';
const CUSTOMER = 'cust_001';
const REPLY = 'phrased reply';

type PendingKind = 'answer_to_pending' | 'new_topic';

/**
 * A fake llm with the third function the next step will add.
 *
 * `order` records the sequence of calls, which is how the "pending check runs
 * first" requirement is asserted.
 */
function makeLlm(options: { intent?: IntentClassification; pending?: PendingKind } = {}) {
  const classification: IntentClassification = options.intent ?? {
    intent: 'order_lookup',
    orderId: '1002',
    wantsHuman: false,
    isComplaint: false,
  };
  const pending: { kind: PendingKind } = { kind: options.pending ?? 'answer_to_pending' };
  const order: string[] = [];

  const llm = {
    classifyIntent: vi.fn(() => {
      order.push('classifyIntent');
      return Promise.resolve(classification);
    }),
    classifyPendingReply: vi.fn(() => {
      order.push('classifyPendingReply');
      return Promise.resolve(pending);
    }),
    // Added once awaiting_order_selection stopped being a placeholder: an
    // answer_to_pending reply in that step now runs the selection logic.
    interpretOrderSelection: vi.fn(() => {
      order.push('interpretOrderSelection');
      return Promise.resolve({ kind: 'choose' as const, choice: 2 });
    }),
    // Likewise for awaiting_confirmation. 'no' on purpose: this file is about
    // routing, so it must never cancel anything.
    interpretConfirmation: vi.fn(() => {
      order.push('interpretConfirmation');
      return Promise.resolve('no' as const);
    }),
    writeReply: vi.fn((input: Parameters<typeof writeReply>[0]) => {
      void input;
      order.push('writeReply');
      return Promise.resolve(REPLY);
    }),
  };

  return { llm, order };
}

const CANDIDATES: CandidateOrder[] = [
  { n: 1, id: '1003', label: 'Phone case (ordered Oct 3)' },
  { n: 2, id: '1005', label: 'Wireless headphones (ordered Oct 6)' },
  { n: 3, id: '1006', label: 'Wireless headphones (ordered Oct 9)' },
];

const AWAITING_SELECTION: SessionState = {
  step: 'awaiting_order_selection',
  candidateOrders: CANDIDATES,
  retries: 1,
};

const AWAITING_CONFIRMATION: SessionState = {
  step: 'awaiting_confirmation',
  selectedOrderId: '1005',
  retries: 0,
};

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('1. idle state keeps today\'s behaviour', () => {
  it('never calls classifyPendingReply and calls classifyIntent once', async () => {
    const repos = createMemoryRepositories();
    const { llm } = makeLlm();

    await handleMessage(SESSION, 'where is my order 1002?', { repos, llm });

    expect(llm.classifyPendingReply).not.toHaveBeenCalled();
    expect(llm.classifyIntent).toHaveBeenCalledTimes(1);
  });

  it('also skips the pending check when a row exists but is idle', async () => {
    const repos = createMemoryRepositories();
    const { llm } = makeLlm();
    await repos.sessions.setState(SESSION, CUSTOMER, { step: 'idle' });

    await handleMessage(SESSION, 'where is my order 1002?', { repos, llm });

    expect(llm.classifyPendingReply).not.toHaveBeenCalled();
    expect(llm.classifyIntent).toHaveBeenCalledTimes(1);
  });
});

describe('2. awaiting_order_selection checks the pending reply first', () => {
  it('calls classifyPendingReply once, with the message and the stored state', async () => {
    const repos = createMemoryRepositories();
    const { llm } = makeLlm({ pending: 'answer_to_pending' });
    await repos.sessions.setState(SESSION, CUSTOMER, AWAITING_SELECTION);

    await handleMessage(SESSION, 'the second one', { repos, llm });

    expect(llm.classifyPendingReply).toHaveBeenCalledTimes(1);
    expect(llm.classifyPendingReply).toHaveBeenCalledWith({
      message: 'the second one',
      state: AWAITING_SELECTION,
    });
  });

  it('calls classifyPendingReply BEFORE classifyIntent', async () => {
    const repos = createMemoryRepositories();
    const { llm, order } = makeLlm({ pending: 'new_topic' });
    await repos.sessions.setState(SESSION, CUSTOMER, AWAITING_SELECTION);

    await handleMessage(SESSION, 'actually, where is order 1002?', { repos, llm });

    expect(order.indexOf('classifyPendingReply')).toBe(0);
    expect(order.indexOf('classifyIntent')).toBeGreaterThan(
      order.indexOf('classifyPendingReply'),
    );
  });
});

describe('3. awaiting_confirmation checks the pending reply first', () => {
  it('calls classifyPendingReply once, with the message and the stored state', async () => {
    const repos = createMemoryRepositories();
    const { llm } = makeLlm({ pending: 'answer_to_pending' });
    await repos.sessions.setState(SESSION, CUSTOMER, AWAITING_CONFIRMATION);

    await handleMessage(SESSION, 'yes', { repos, llm });

    expect(llm.classifyPendingReply).toHaveBeenCalledTimes(1);
    expect(llm.classifyPendingReply).toHaveBeenCalledWith({
      message: 'yes',
      state: AWAITING_CONFIRMATION,
    });
  });

  it('calls classifyPendingReply BEFORE classifyIntent', async () => {
    const repos = createMemoryRepositories();
    const { llm, order } = makeLlm({ pending: 'new_topic' });
    await repos.sessions.setState(SESSION, CUSTOMER, AWAITING_CONFIRMATION);

    await handleMessage(SESSION, 'forget it, where is order 1002?', { repos, llm });

    expect(order.indexOf('classifyPendingReply')).toBe(0);
    expect(order.indexOf('classifyIntent')).toBeGreaterThan(
      order.indexOf('classifyPendingReply'),
    );
  });
});

describe('4. new_topic resets the state, then routes normally', () => {
  it('stores step idle with no candidateOrders and no selectedOrderId', async () => {
    const repos = createMemoryRepositories();
    const { llm } = makeLlm({ pending: 'new_topic' });
    await repos.sessions.setState(SESSION, CUSTOMER, AWAITING_SELECTION);

    await handleMessage(SESSION, 'actually, where is order 1002?', { repos, llm });

    const stored = await repos.sessions.getState(SESSION);
    expect(stored.step).toBe('idle');
    expect(stored.candidateOrders).toBeUndefined();
    expect(stored.selectedOrderId).toBeUndefined();
  });

  it('then calls classifyIntent and returns a normal reply', async () => {
    const repos = createMemoryRepositories();
    const { llm } = makeLlm({ pending: 'new_topic' });
    await repos.sessions.setState(SESSION, CUSTOMER, AWAITING_SELECTION);

    const response = await handleMessage(SESSION, 'actually, where is order 1002?', {
      repos,
      llm,
    });

    expect(llm.classifyIntent).toHaveBeenCalledTimes(1);
    expect(ChatResponseSchema.safeParse(response).success).toBe(true);
    expect(response.intent).toBe('order_lookup');
    expect(response.answer).toBe(REPLY);
  });

  it('passes facts about order 1002 to writeReply', async () => {
    const repos = createMemoryRepositories();
    const { llm } = makeLlm({ pending: 'new_topic' });
    await repos.sessions.setState(SESSION, CUSTOMER, AWAITING_SELECTION);

    await handleMessage(SESSION, 'actually, where is order 1002?', { repos, llm });

    const call = llm.writeReply.mock.calls[0];
    if (!call) throw new Error('writeReply was not called');
    // orderFacts no longer puts the order id in the facts, so the order is
    // identified by its item name, which is unique to 1002 in the seed data.
    expect(call[0].facts).toContain('USB-C cable');
    expect(call[0].facts).toContain('Status: shipped.');
  });
});

describe('5. answer_to_pending in awaiting_order_selection runs the selection logic', () => {
  it('does not call classifyIntent', async () => {
    const repos = createMemoryRepositories();
    const { llm } = makeLlm({ pending: 'answer_to_pending' });
    await repos.sessions.setState(SESSION, CUSTOMER, AWAITING_SELECTION);

    await handleMessage(SESSION, 'the second one', { repos, llm });

    expect(llm.classifyIntent).not.toHaveBeenCalled();
  });

  it('routes to the selection logic instead of a placeholder', async () => {
    const repos = createMemoryRepositories();
    const { llm } = makeLlm({ pending: 'answer_to_pending' });
    await repos.sessions.setState(SESSION, CUSTOMER, AWAITING_SELECTION);

    const response = await handleMessage(SESSION, 'the second one', { repos, llm });

    expect(ChatResponseSchema.safeParse(response).success).toBe(true);
    expect(response.intent).toBe('cancel_order');
    expect(llm.interpretOrderSelection).toHaveBeenCalledTimes(1);
    expect(response.answer).not.toContain('not implemented yet');
  });

  it('advances the stored state to the chosen order', async () => {
    const repos = createMemoryRepositories();
    const { llm } = makeLlm({ pending: 'answer_to_pending' });
    await repos.sessions.setState(SESSION, CUSTOMER, AWAITING_SELECTION);

    await handleMessage(SESSION, 'the second one', { repos, llm });

    // The fake chooses option 2, which is order 1005 in AWAITING_SELECTION.
    expect(await repos.sessions.getState(SESSION)).toEqual({
      step: 'awaiting_confirmation',
      selectedOrderId: '1005',
      retries: 0,
    });
  });
});

describe('6. answer_to_pending in awaiting_confirmation runs the confirmation logic', () => {
  it('keeps the selected order and never classifies the intent', async () => {
    const repos = createMemoryRepositories();
    const { llm } = makeLlm({ pending: 'answer_to_pending' });
    await repos.sessions.setState(SESSION, CUSTOMER, AWAITING_CONFIRMATION);

    await handleMessage(SESSION, 'yes', { repos, llm });

    // The fake answers 'no', and confirmation is binary (design Q8), so the
    // flow ends: no re-ask, no retries, back to idle.
    const after = await repos.sessions.getState(SESSION);
    expect(after).toEqual({ step: 'idle' });
    expect(llm.interpretConfirmation).toHaveBeenCalledTimes(1);
    expect(llm.classifyIntent).not.toHaveBeenCalled();
  });
});
