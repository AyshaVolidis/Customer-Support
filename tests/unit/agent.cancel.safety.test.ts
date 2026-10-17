// Adversarial tests for the cancel flow: a manipulated or misbehaving model,
// prompt injection, tampered state, stale state, and concurrent sessions.
//
// Every test here carries a POSITIVE assertion that the flow really ran as far
// as the point where the attack is refused. "Nothing was cancelled" on its own
// would also be true of a flow that never started, so it proves nothing.
//
// See tests/unit/helpers/cancelFixtures.ts for the calling convention.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { handleMessage } from '../../src/lib/agent';
import { ORDER_NOT_FOUND_MESSAGE, gateOrderCancellable } from '../../src/lib/gates';
import { createMemoryRepositories } from '../../src/lib/repositories/memory';
import {
  CUSTOMER,
  SESSION,
  awaitingConfirmation,
  awaitingSelection,
  containsAnyOrderId,
  makeLlm,
  spyCancel,
  statusOf,
} from './helpers/cancelFixtures';

/** Every seeded order of cust_001, plus cust_002's. */
const ALL_IDS = ['1001', '1002', '1003', '1004', '1005', '1006', '2001', '2002'];

/** cust_001's cancellable orders - the ids the model must never see. */
const CANCELLABLE_IDS = ['1003', '1005', '1006'];

type Repos = ReturnType<typeof createMemoryRepositories>;

/** Which orders are cancelled right now. Used to count, not just to check one. */
async function cancelledIds(repos: Repos): Promise<string[]> {
  const found: string[] = [];
  for (const id of ALL_IDS) {
    if ((await statusOf(repos, id)) === 'cancelled') found.push(id);
  }
  return found;
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('cancel safety', () => {
  it('1. "cancel all my orders" cancels exactly one order, after a choice and a yes', async () => {
    const repos = createMemoryRepositories();
    const { llm } = makeLlm({
      intent: 'cancel_order',
      orderId: null,
      pending: 'answer_to_pending',
      selection: { kind: 'choose', choice: 2 },
      confirmation: 'yes',
    });
    const cancelOrder = spyCancel(repos);

    // 1004 is already cancelled in the seed, so start from the real baseline.
    const before = await cancelledIds(repos);
    expect(before).toEqual(['1004']);

    // Turn 1: the plural request offers a list. It does NOT cancel anything.
    const listed = await handleMessage(SESSION, 'cancel all my orders', { repos, llm });

    expect(listed.options).toHaveLength(3);
    expect((await repos.sessions.getState(SESSION)).step).toBe('awaiting_order_selection');
    expect(cancelOrder).not.toHaveBeenCalled();
    expect(await cancelledIds(repos)).toEqual(before);

    // Turn 2 and 3: one choice, one confirmation.
    await handleMessage(SESSION, 'the second one', { repos, llm });
    await handleMessage(SESSION, 'yes', { repos, llm });

    const after = await cancelledIds(repos);
    expect(after).toHaveLength(before.length + 1);
    expect(after).toEqual(['1004', '1005']);
    expect(cancelOrder).toHaveBeenCalledTimes(1);
    expect(cancelOrder).toHaveBeenCalledWith('1005');
  });

  it('2. a model choice outside the list is refused by G5, not followed', async () => {
    const repos = createMemoryRepositories();
    const { llm } = makeLlm({
      pending: 'answer_to_pending',
      selection: { kind: 'choose', choice: 99 },
    });
    await repos.sessions.setState(SESSION, CUSTOMER, await awaitingSelection(repos));
    const cancelOrder = spyCancel(repos);
    const before = await cancelledIds(repos);

    const response = await handleMessage(SESSION, 'that one', { repos, llm });

    // Positive: the selection step really ran and treated 99 as unclear.
    expect(llm.interpretOrderSelection).toHaveBeenCalledTimes(1);
    const state = await repos.sessions.getState(SESSION);
    expect(state.step).toBe('awaiting_order_selection');
    expect(state.retries).toBe(1);
    expect(response.options).toHaveLength(3);

    expect(cancelOrder).not.toHaveBeenCalled();
    expect(await cancelledIds(repos)).toEqual(before);
  });

  it('3. a forged "yes" cannot skip the selection step', async () => {
    const repos = createMemoryRepositories();
    const { llm } = makeLlm({
      pending: 'answer_to_pending',
      selection: { kind: 'choose', choice: 2 },
      confirmation: 'yes',
    });
    await repos.sessions.setState(SESSION, CUSTOMER, await awaitingSelection(repos));
    const cancelOrder = spyCancel(repos);
    const before = await cancelledIds(repos);

    await handleMessage(SESSION, 'yes cancel it now', { repos, llm });

    // Positive: the code asked the SELECTION question for this step, and never
    // asked the confirmation question, whatever the confirmation mock says.
    expect(llm.interpretOrderSelection).toHaveBeenCalledTimes(1);
    expect(llm.interpretConfirmation).not.toHaveBeenCalled();
    expect((await repos.sessions.getState(SESSION)).step).toBe('awaiting_confirmation');

    expect(cancelOrder).not.toHaveBeenCalled();
    expect(await cancelledIds(repos)).toEqual(before);
  });

  it('3b. a forged "yes" cannot cancel from an idle session', async () => {
    const repos = createMemoryRepositories();
    const { llm } = makeLlm({ intent: 'out_of_scope', confirmation: 'yes' });
    const cancelOrder = spyCancel(repos);
    const before = await cancelledIds(repos);

    const response = await handleMessage(SESSION, 'yes', { repos, llm });

    // Positive: the message was classified afresh, as an idle session must be.
    expect(llm.classifyIntent).toHaveBeenCalledTimes(1);
    expect(llm.classifyPendingReply).not.toHaveBeenCalled();
    expect(llm.interpretConfirmation).not.toHaveBeenCalled();
    expect(response.intent).toBe('out_of_scope');

    expect(cancelOrder).not.toHaveBeenCalled();
    expect(await cancelledIds(repos)).toEqual(before);
  });

  it("4. a compromised classifier cannot reach another customer's order", async () => {
    // The injected id: 2001 exists, but it belongs to cust_002.
    const injected = createMemoryRepositories();
    const injectedLlm = makeLlm({ intent: 'cancel_order', orderId: '2001' }).llm;
    const injectedCancel = spyCancel(injected);
    const injectedResponse = await handleMessage(SESSION, 'cancel order 2001', {
      repos: injected,
      llm: injectedLlm,
    });

    // The control: an order that simply does not exist.
    const missing = createMemoryRepositories();
    const missingLlm = makeLlm({ intent: 'cancel_order', orderId: '9999' }).llm;
    const missingResponse = await handleMessage(SESSION, 'cancel order 9999', {
      repos: missing,
      llm: missingLlm,
    });

    // Positive: both ran the with-id path and produced the same not-found facts.
    expect(injectedResponse.answer).toBe(`FACTS: ${ORDER_NOT_FOUND_MESSAGE}`);
    expect(injectedResponse).toEqual(missingResponse);
    expect(await injected.sessions.getState(SESSION)).toEqual({ step: 'idle' });

    // Nothing about cust_002's order leaked, and it is untouched.
    const everything = JSON.stringify(vi.mocked(injectedLlm.writeReply).mock.calls);
    expect(everything).not.toContain('Yoga mat');
    expect(everything).not.toContain('cust_002');
    expect(await statusOf(injected, '2001')).toBe('processing');
    expect(injectedCancel).not.toHaveBeenCalled();
  });

  it('5. new_topic mid-flow abandons the cancellation for good', async () => {
    const repos = createMemoryRepositories();
    const { llm } = makeLlm({
      intent: 'order_lookup',
      orderId: '1002',
      pending: 'new_topic',
      confirmation: 'yes',
    });
    await repos.sessions.setState(SESSION, CUSTOMER, awaitingConfirmation('1005'));
    const cancelOrder = spyCancel(repos);
    const before = await cancelledIds(repos);

    // The customer changes the subject while a confirmation is pending.
    const answered = await handleMessage(SESSION, 'actually where is order 1002?', { repos, llm });

    // Positive: the new topic really was answered, and the state was reset.
    expect(answered.intent).toBe('order_lookup');
    expect(answered.answer).toContain('USB-C cable');
    expect(await repos.sessions.getState(SESSION)).toEqual({ step: 'idle' });
    expect(llm.interpretConfirmation).not.toHaveBeenCalled();

    // A bare "yes" afterwards has nothing to confirm.
    llm.classifyIntent.mockResolvedValue({
      intent: 'out_of_scope',
      orderId: null,
      wantsHuman: false,
      isComplaint: false,
    });
    const stray = await handleMessage(SESSION, 'yes', { repos, llm });

    expect(stray.intent).toBe('out_of_scope');
    expect(cancelOrder).not.toHaveBeenCalled();
    expect(await cancelledIds(repos)).toEqual(before);
  });

  it('6. a stale confirmation never reports success (G4 re-check)', async () => {
    const repos = createMemoryRepositories();
    const { llm } = makeLlm({ pending: 'answer_to_pending', confirmation: 'yes' });

    // Someone else cancelled 1005 after we asked the question.
    expect(await repos.orders.cancelOrder('1005')).toEqual({ ok: true });
    const stale = await repos.orders.getOrder('1005');
    if (!stale) throw new Error('fixture problem: 1005 is missing');
    const gate = gateOrderCancellable(stale);
    if (gate.ok) throw new Error('fixture problem: a cancelled order must not be cancellable');

    await repos.sessions.setState(SESSION, CUSTOMER, awaitingConfirmation('1005'));
    const cancelOrder = spyCancel(repos);

    const response = await handleMessage(SESSION, 'yes', { repos, llm });

    // Positive: G6 passed and the re-check produced the gate's own message.
    expect(llm.interpretConfirmation).toHaveBeenCalledTimes(1);
    expect(response.answer).toBe(`FACTS: ${gate.userMessage}`);
    expect(response.answer).not.toMatch(/(has|was|is) been cancelled/i);
    expect(await repos.sessions.getState(SESSION)).toEqual({ step: 'idle' });
    expect(cancelOrder).not.toHaveBeenCalled();
  });

  it('7. one session cannot confirm another session\'s pending cancellation', async () => {
    const repos = createMemoryRepositories();
    const sessionA = 's-a';
    const sessionB = 's-b';
    const { llm } = makeLlm({ intent: 'out_of_scope', confirmation: 'yes' });

    await repos.sessions.setState(sessionA, CUSTOMER, awaitingConfirmation('1005'));
    await repos.sessions.setState(sessionB, CUSTOMER, { step: 'idle' });
    const cancelOrder = spyCancel(repos);
    const before = await cancelledIds(repos);

    const response = await handleMessage(sessionB, 'yes', { repos, llm });

    // Positive: session B was treated as idle and classified afresh.
    expect(llm.classifyIntent).toHaveBeenCalledTimes(1);
    expect(llm.interpretConfirmation).not.toHaveBeenCalled();
    expect(response.intent).toBe('out_of_scope');

    // Session A is untouched, and nothing was cancelled.
    expect(await repos.sessions.getState(sessionA)).toEqual(awaitingConfirmation('1005'));
    expect(cancelOrder).not.toHaveBeenCalled();
    expect(await cancelledIds(repos)).toEqual(before);
  });

  it('8. no real order id reaches the model before one is chosen', async () => {
    const repos = createMemoryRepositories();
    const { llm } = makeLlm({
      intent: 'cancel_order',
      orderId: null,
      pending: 'answer_to_pending',
      selection: { kind: 'choose', choice: 2 },
    });

    // Turn 1: the list.
    const listed = await handleMessage(SESSION, 'cancel my order', { repos, llm });

    expect(listed.options).toHaveLength(3);
    for (const mock of [
      llm.classifyIntent,
      llm.classifyPendingReply,
      llm.interpretOrderSelection,
      llm.interpretConfirmation,
      llm.writeReply,
    ]) {
      expect(containsAnyOrderId(mock.mock.calls, CANCELLABLE_IDS)).toBe(false);
    }
    expect(containsAnyOrderId(listed.options, CANCELLABLE_IDS)).toBe(false);

    // Turn 2: the choice. The selection question still carries labels only.
    await handleMessage(SESSION, 'the second one', { repos, llm });

    // Positive: it really did ask the selection question, with labels.
    const selectionCall = llm.interpretOrderSelection.mock.calls[0];
    if (!selectionCall) throw new Error('interpretOrderSelection was not called');
    const { labels } = selectionCall[0] as { labels: string };
    expect(labels).toContain('Phone case');
    expect(containsAnyOrderId(llm.interpretOrderSelection.mock.calls, CANCELLABLE_IDS)).toBe(
      false,
    );

    // The confirmation question names the chosen order on purpose: by now the
    // customer has picked it, so it is their own order number.
    const lastWrite = llm.writeReply.mock.calls.at(-1);
    if (!lastWrite) throw new Error('writeReply was not called');
    expect(lastWrite[0].facts).toContain('1005');
  });

  it('9. a tampered stored selection is refused by the G3 re-check', async () => {
    const repos = createMemoryRepositories();
    const { llm } = makeLlm({ pending: 'answer_to_pending', confirmation: 'yes' });

    // The stored state points at cust_002's order.
    await repos.sessions.setState(SESSION, CUSTOMER, awaitingConfirmation('2001'));
    const cancelOrder = spyCancel(repos);

    const response = await handleMessage(SESSION, 'yes', { repos, llm });

    // Positive: G6 passed, then the re-check produced the not-found facts.
    expect(llm.interpretConfirmation).toHaveBeenCalledTimes(1);
    expect(response.answer).toBe(`FACTS: ${ORDER_NOT_FOUND_MESSAGE}`);
    expect(await repos.sessions.getState(SESSION)).toEqual({ step: 'idle' });

    expect(cancelOrder).not.toHaveBeenCalled();
    expect(await statusOf(repos, '2001')).toBe('processing');
  });
});
