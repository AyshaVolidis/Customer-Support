// TDD (red): the cancel_order flow does not exist yet.
//
// This file covers only "cancel order <id>" up to the confirmation question.
// Nothing is cancelled here: cancelOrder must never be called.
//
// See tests/unit/helpers/cancelFixtures.ts for the calling convention. The
// short version: writeReply returns `FACTS: ${facts}`, so response.answer is
// the facts the CODE produced, verbatim.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { handleMessage } from '../../src/lib/agent';
import { labelsForLlm, toOptions } from '../../src/lib/cancelHelpers';
import { ORDER_NOT_FOUND_MESSAGE, gateOrderCancellable } from '../../src/lib/gates';
import { createMemoryRepositories } from '../../src/lib/repositories/memory';
import type { CandidateOrder, Order, SessionState } from '../../src/lib/repositories/types';
import {
  CUSTOMER,
  SESSION,
  awaitingSelection,
  containsAnyOrderId,
  makeLlm,
  spyCancel,
  statusOf,
} from './helpers/cancelFixtures';

const G1_MESSAGE = 'Order numbers are four digits, like 1002.';

/** The real ids of cust_001's cancellable orders, oldest first. */
const CANCELLABLE_IDS = ['1003', '1005', '1006'];

/**
 * NOTE: src/lib/config.ts has no MAX_RETRIES yet, so it cannot be imported.
 * This is the value docs/design.md section 4 specifies ("With MAX_RETRIES = 2,
 * the customer gets two re-asks and the third unclear reply goes to idle").
 * Replace this with the import once the constant exists.
 */
const MAX_RETRIES = 2;

/** What the code passed to interpretOrderSelection on its first call. */
function selectionInput(llm: ReturnType<typeof makeLlm>['llm']): {
  message: string;
  labels: string;
} {
  const call = llm.interpretOrderSelection.mock.calls[0];
  if (!call) throw new Error('interpretOrderSelection was not called');
  return call[0] as { message: string; labels: string };
}

/** Store the awaiting_order_selection state, returning the candidates used. */
async function putAwaitingSelection(
  repos: ReturnType<typeof createMemoryRepositories>,
  override?: (state: SessionState) => SessionState,
): Promise<CandidateOrder[]> {
  const base = await awaitingSelection(repos);
  const state = override ? override(base) : base;
  await repos.sessions.setState(SESSION, CUSTOMER, state);
  return state.candidateOrders ?? [];
}

/** The userMessage gateOrderCancellable gives for one order, from the real gate. */
async function cancellableGateMessage(
  repos: ReturnType<typeof createMemoryRepositories>,
  orderId: string,
): Promise<string> {
  const order = await repos.orders.getOrder(orderId);
  if (!order) throw new Error(`fixture problem: order ${orderId} is missing`);

  const gate = gateOrderCancellable(order);
  if (gate.ok) throw new Error(`fixture problem: order ${orderId} is cancellable`);

  return gate.userMessage;
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('cancel flow', () => {
  describe('with an order id', () => {
    it('1. asks to confirm a processing order, and changes nothing else', async () => {
      const repos = createMemoryRepositories();
      const { llm } = makeLlm({ intent: 'cancel_order', orderId: '1005' });
      const cancelOrder = spyCancel(repos);

      const response = await handleMessage(SESSION, 'cancel order 1005', { repos, llm });

      // The response the customer gets.
      expect(response.intent).toBe('cancel_order');
      expect(response.needsConfirmation).toBe(true);
      expect(response.options).toEqual([]);

      // The facts handed to the model carry both the id and the item name.
      expect(response.answer).toContain('1005');
      expect(response.answer).toContain('Wireless headphones');

      // The state is exactly the confirmation state.
      expect(await repos.sessions.getState(SESSION)).toEqual({
        step: 'awaiting_confirmation',
        selectedOrderId: '1005',
        retries: 0,
      });

      // Nothing was cancelled.
      expect(cancelOrder).not.toHaveBeenCalled();
      expect(await statusOf(repos, '1005')).toBe('processing');
    });

    it('2. refuses a shipped order with the gate\'s own message (G4)', async () => {
      const repos = createMemoryRepositories();
      const { llm } = makeLlm({ intent: 'cancel_order', orderId: '1002' });
      const cancelOrder = spyCancel(repos);
      const expected = await cancellableGateMessage(repos, '1002');

      const response = await handleMessage(SESSION, 'cancel order 1002', { repos, llm });

      expect(response.answer).toBe(`FACTS: ${expected}`);
      expect(response.needsConfirmation).toBe(false);
      expect(await repos.sessions.getState(SESSION)).toEqual({ step: 'idle' });
      expect(cancelOrder).not.toHaveBeenCalled();
      expect(await statusOf(repos, '1002')).toBe('shipped');
    });

    it('3. refuses an already cancelled order (G4)', async () => {
      const repos = createMemoryRepositories();
      const { llm } = makeLlm({ intent: 'cancel_order', orderId: '1004' });
      const cancelOrder = spyCancel(repos);
      const expected = await cancellableGateMessage(repos, '1004');

      const response = await handleMessage(SESSION, 'cancel order 1004', { repos, llm });

      expect(response.answer).toBe(`FACTS: ${expected}`);
      expect(response.needsConfirmation).toBe(false);
      expect(await repos.sessions.getState(SESSION)).toEqual({ step: 'idle' });
      expect(cancelOrder).not.toHaveBeenCalled();
    });

    it('4. answers identically for someone else\'s order and a missing one (G2 = G3)', async () => {
      const other = createMemoryRepositories();
      const otherLlm = makeLlm({ intent: 'cancel_order', orderId: '2001' }).llm;
      const otherCancel = spyCancel(other);
      const otherResponse = await handleMessage(SESSION, 'cancel order 2001', {
        repos: other,
        llm: otherLlm,
      });
      const otherState = await other.sessions.getState(SESSION);

      const missing = createMemoryRepositories();
      const missingLlm = makeLlm({ intent: 'cancel_order', orderId: '9999' }).llm;
      const missingCancel = spyCancel(missing);
      const missingResponse = await handleMessage(SESSION, 'cancel order 9999', {
        repos: missing,
        llm: missingLlm,
      });
      const missingState = await missing.sessions.getState(SESSION);

      expect(otherResponse).toEqual(missingResponse);
      expect(otherState).toEqual(missingState);
      expect(otherResponse.answer).toBe(`FACTS: ${ORDER_NOT_FOUND_MESSAGE}`);
      expect(otherState).toEqual({ step: 'idle' });

      // cust_002's order is untouched, and nothing leaked about it.
      expect(await statusOf(other, '2001')).toBe('processing');
      expect(otherResponse.answer).not.toContain('Yoga mat');
      expect(otherCancel).not.toHaveBeenCalled();
      expect(missingCancel).not.toHaveBeenCalled();
    });

    it('5. rejects a malformed number and never falls back to the latest order (G1)', async () => {
      for (const badId of ['12', '10025']) {
        const repos = createMemoryRepositories();
        const { llm } = makeLlm({ intent: 'cancel_order', orderId: badId });
        const cancelOrder = spyCancel(repos);

        const response = await handleMessage(SESSION, `cancel order ${badId}`, { repos, llm });

        expect(response.answer).toBe(`FACTS: ${G1_MESSAGE}`);
        expect(response.needsConfirmation).toBe(false);
        expect(await repos.sessions.getState(SESSION)).toEqual({ step: 'idle' });
        expect(response.answer).not.toContain('1006');
        expect(cancelOrder).not.toHaveBeenCalled();
      }
    });

    it('6. builds the new state from scratch, dropping handoffOffered and problemText', async () => {
      const repos = createMemoryRepositories();
      const { llm } = makeLlm({ intent: 'cancel_order', orderId: '1005' });
      const cancelOrder = spyCancel(repos);
      await repos.sessions.setState(SESSION, CUSTOMER, {
        step: 'idle',
        handoffOffered: true,
        problemText: 'x',
      });

      await handleMessage(SESSION, 'cancel order 1005', { repos, llm });

      const state = await repos.sessions.getState(SESSION);
      expect(state).toEqual({
        step: 'awaiting_confirmation',
        selectedOrderId: '1005',
        retries: 0,
      });
      expect(state.handoffOffered).toBeUndefined();
      expect(state.problemText).toBeUndefined();
      expect(cancelOrder).not.toHaveBeenCalled();
    });
  });

  describe('listing the choices', () => {
    /** Ask to cancel with no order number given. */
    async function askWithoutId(repos: ReturnType<typeof createMemoryRepositories>) {
      const { llm } = makeLlm({ intent: 'cancel_order', orderId: null });
      const cancelOrder = spyCancel(repos);
      const response = await handleMessage(SESSION, 'cancel my order', { repos, llm });
      console.log('response.answer:', response.options.map((o) => o.label).join(' | '));
      return { llm, cancelOrder, response };
    }

    it('1. offers three options, numbered 1-3, oldest order first', async () => {
      const repos = createMemoryRepositories();

      const { response, cancelOrder } = await askWithoutId(repos);

      expect(response.intent).toBe('cancel_order');
      expect(response.needsConfirmation).toBe(false);
      expect(response.options).toHaveLength(3);
      expect(response.options.map((option) => option.id)).toEqual(['1', '2', '3']);

      // Oldest first: 1003 (Oct 3), 1005 (Oct 6), 1006 (Oct 9).
      const labels = response.options.map((option) => option.label);
      expect(labels[0]).toContain('Phone case');
      expect(labels[1]).toContain('Wireless headphones');
      expect(labels[2]).toContain('Wireless headphones');
      expect(labels[1]).toContain('Oct');

      expect(cancelOrder).not.toHaveBeenCalled();
    });

    it('2. gives the two identical item names distinguishable labels', async () => {
      const repos = createMemoryRepositories();

      const { response, cancelOrder } = await askWithoutId(repos);

      const headphones = response.options.filter((option) =>
        option.label.startsWith('Wireless headphones'),
      );
      expect(headphones).toHaveLength(2);
      expect(headphones[0]?.label).not.toBe(headphones[1]?.label);
      expect(cancelOrder).not.toHaveBeenCalled();
    });

    it('3. stores the candidates, with the real ids, in the state', async () => {
      const repos = createMemoryRepositories();

      const { cancelOrder } = await askWithoutId(repos);

      const state = await repos.sessions.getState(SESSION);
      expect(state.step).toBe('awaiting_order_selection');
      expect(state.retries).toBe(0);
      expect(state.candidateOrders?.map((candidate) => candidate.id)).toEqual(CANCELLABLE_IDS);
      expect(state.candidateOrders?.map((candidate) => candidate.n)).toEqual([1, 2, 3]);
      expect(cancelOrder).not.toHaveBeenCalled();
    });

    it('4. never hands a real order id to the model, or to the options', async () => {
      const repos = createMemoryRepositories();

      const { llm, response, cancelOrder } = await askWithoutId(repos);

      // The listing must actually have happened, otherwise "no id reached the
      // model" would be true simply because nothing was sent at all.
      expect(llm.writeReply).toHaveBeenCalledTimes(1);
      const facts = llm.writeReply.mock.calls[0]?.[0].facts ?? '';
      expect(facts).toContain('Phone case');
      expect(facts).toContain('Wireless headphones');

      // Every argument of every llm call this turn.
      expect(containsAnyOrderId(llm.classifyIntent.mock.calls, CANCELLABLE_IDS)).toBe(false);
      expect(containsAnyOrderId(llm.classifyPendingReply.mock.calls, CANCELLABLE_IDS)).toBe(false);
      expect(containsAnyOrderId(llm.interpretOrderSelection.mock.calls, CANCELLABLE_IDS)).toBe(
        false,
      );
      expect(containsAnyOrderId(llm.interpretConfirmation.mock.calls, CANCELLABLE_IDS)).toBe(false);
      expect(containsAnyOrderId(llm.writeReply.mock.calls, CANCELLABLE_IDS)).toBe(false);

      // And the options the browser receives.
      expect(containsAnyOrderId(response.options, CANCELLABLE_IDS)).toBe(false);
      expect(cancelOrder).not.toHaveBeenCalled();
    });

    it('5. says there is nothing to cancel when no order is processing', async () => {
      const repos = createMemoryRepositories();
      for (const id of CANCELLABLE_IDS) {
        expect(await repos.orders.cancelOrder(id)).toEqual({ ok: true });
      }

      const { response, cancelOrder } = await askWithoutId(repos);
      expect(response.options).toEqual([]);
      expect(response.needsConfirmation).toBe(false);
      // The reply must come from writeReply (so it is phrased from facts), and
      // must not be the placeholder. Checking for 'no' alone would pass on
      // "not implemented", which contains it.
      expect(response.answer.startsWith('FACTS: ')).toBe(true);
      expect(response.answer).not.toContain('not implemented');
      expect(await repos.sessions.getState(SESSION)).toEqual({ step: 'idle' });
      expect(cancelOrder).not.toHaveBeenCalled();
    });

    it('6. offers exactly one option when only one order is cancellable', async () => {
      // NOTE: handleMessage hardcodes DEMO_CUSTOMER_ID and takes no customer
      // parameter, so a different customer cannot be reached through deps.
      // Instead cust_001 is reduced to a single cancellable order.
      const repos = createMemoryRepositories();
      expect(await repos.orders.cancelOrder('1003')).toEqual({ ok: true });
      expect(await repos.orders.cancelOrder('1006')).toEqual({ ok: true });

      const { response, cancelOrder } = await askWithoutId(repos);

      expect(response.options).toHaveLength(1);
      expect(response.options[0]?.id).toBe('1');
      expect(response.options[0]?.label).toContain('Wireless headphones');

      const state = await repos.sessions.getState(SESSION);
      expect(state.step).toBe('awaiting_order_selection');
      expect(state.candidateOrders?.map((candidate) => candidate.id)).toEqual(['1005']);
      expect(cancelOrder).not.toHaveBeenCalled();
    });
  });

  describe('selecting an order', () => {
    it('1. a valid choice moves to awaiting_confirmation', async () => {
      const repos = createMemoryRepositories();
      const { llm } = makeLlm({
        pending: 'answer_to_pending',
        selection: { kind: 'choose', choice: 2 },
      });
      const cancelOrder = spyCancel(repos);
      await putAwaitingSelection(repos);

      const response = await handleMessage(SESSION, 'the second one', { repos, llm });

      expect(response.intent).toBe('cancel_order');
      expect(response.needsConfirmation).toBe(true);
      expect(response.answer).toContain('1005');
      expect(response.answer).toContain('Wireless headphones');

      expect(await repos.sessions.getState(SESSION)).toEqual({
        step: 'awaiting_confirmation',
        selectedOrderId: '1005',
        retries: 0,
      });

      expect(cancelOrder).not.toHaveBeenCalled();
      expect(await statusOf(repos, '1005')).toBe('processing');
    });

    it('2. the model is given the numbered labels, and no order id', async () => {
      const repos = createMemoryRepositories();
      const { llm } = makeLlm({
        pending: 'answer_to_pending',
        selection: { kind: 'choose', choice: 2 },
      });
      const cancelOrder = spyCancel(repos);
      const candidates = await putAwaitingSelection(repos);

      await handleMessage(SESSION, 'the second one', { repos, llm });

      expect(selectionInput(llm).labels).toBe(labelsForLlm(candidates));
      expect(containsAnyOrderId(llm.interpretOrderSelection.mock.calls, CANCELLABLE_IDS)).toBe(
        false,
      );
      expect(cancelOrder).not.toHaveBeenCalled();
    });

    it('3. the real id comes from the stored state, not from the model', async () => {
      const repos = createMemoryRepositories();
      const { llm } = makeLlm({
        pending: 'answer_to_pending',
        selection: { kind: 'choose', choice: 2 },
      });
      const cancelOrder = spyCancel(repos);

      // Tamper with the stored list: option 2 now points at 1006.
      await putAwaitingSelection(repos, (state) => ({
        ...state,
        candidateOrders: [
          { n: 1, id: '1003', label: 'Phone case (first)' },
          { n: 2, id: '1006', label: 'Wireless headphones (second)' },
          { n: 3, id: '1005', label: 'Wireless headphones (third)' },
        ],
      }));

      await handleMessage(SESSION, 'the second one', { repos, llm });

      const state = await repos.sessions.getState(SESSION);
      expect(state.selectedOrderId).toBe('1006');
      expect(state.step).toBe('awaiting_confirmation');
      expect(cancelOrder).not.toHaveBeenCalled();
    });

    it('4. a choice outside 1..N is treated as unclear (G5)', async () => {
      for (const choice of [0, 7, -1, 1.5]) {
        const repos = createMemoryRepositories();
        const { llm } = makeLlm({
          pending: 'answer_to_pending',
          selection: { kind: 'choose', choice },
        });
        const cancelOrder = spyCancel(repos);
        const candidates = await putAwaitingSelection(repos);

        const response = await handleMessage(SESSION, 'that one', { repos, llm });

        const state = await repos.sessions.getState(SESSION);
        expect(state.step).toBe('awaiting_order_selection');
        expect(state.retries).toBe(1);
        expect(response.needsConfirmation).toBe(false);
        expect(response.options).toEqual(toOptions(candidates));
        expect(cancelOrder).not.toHaveBeenCalled();
      }
    });

    it('5. unclear replies ask again, then give up after MAX_RETRIES', async () => {
      const repos = createMemoryRepositories();
      const { llm } = makeLlm({
        pending: 'answer_to_pending',
        selection: { kind: 'unclear', choice: null },
      });
      const cancelOrder = spyCancel(repos);
      await putAwaitingSelection(repos);

      // MAX_RETRIES unclear replies: still asking, retries counting up.
      for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {
        const response = await handleMessage(SESSION, 'hmm', { repos, llm });
        const state = await repos.sessions.getState(SESSION);

        expect(state.step).toBe('awaiting_order_selection');
        expect(state.retries).toBe(attempt);
        expect(response.options).toHaveLength(3);
      }

      // One more: give up politely.
      const response = await handleMessage(SESSION, 'hmm', { repos, llm });
      const state = await repos.sessions.getState(SESSION);

      expect(state.step).toBe('idle');
      expect(state.candidateOrders).toBeUndefined();
      expect(response.needsConfirmation).toBe(false);
      expect(response.options).toEqual([]);
      expect(cancelOrder).not.toHaveBeenCalled();
    });

    it('6. back_out returns to idle and cancels nothing', async () => {
      const repos = createMemoryRepositories();
      const { llm } = makeLlm({
        pending: 'answer_to_pending',
        selection: { kind: 'back_out', choice: null },
      });
      const cancelOrder = spyCancel(repos);
      await putAwaitingSelection(repos);

      const response = await handleMessage(SESSION, 'never mind', { repos, llm });

      expect(await repos.sessions.getState(SESSION)).toEqual({ step: 'idle' });
      expect(response.needsConfirmation).toBe(false);
      expect(response.answer.startsWith('FACTS: ')).toBe(true);
      expect(response.answer.toLowerCase()).toContain('nothing');
      expect(cancelOrder).not.toHaveBeenCalled();
    });

    it('7. refuses if the chosen order stopped being cancellable (G4 re-check)', async () => {
      const repos = createMemoryRepositories();
      const { llm } = makeLlm({
        pending: 'answer_to_pending',
        selection: { kind: 'choose', choice: 2 },
      });
      const cancelOrder = spyCancel(repos);
      await putAwaitingSelection(repos);

      const shipped: Order = {
        id: '1005',
        customerId: CUSTOMER,
        status: 'shipped',
        itemSummary: 'Wireless headphones',
        createdAt: '2026-10-06T09:00:00.000Z',
      };
      vi.spyOn(repos.orders, 'getOrder').mockResolvedValue(shipped);
      const expected = gateOrderCancellable(shipped);
      if (expected.ok) throw new Error('fixture problem: shipped should not be cancellable');

      const response = await handleMessage(SESSION, 'the second one', { repos, llm });

      expect(response.answer).toBe(`FACTS: ${expected.userMessage}`);
      expect(response.needsConfirmation).toBe(false);
      expect(await repos.sessions.getState(SESSION)).toEqual({ step: 'idle' });
      expect(cancelOrder).not.toHaveBeenCalled();
    });

    it('8. refuses if the chosen order now belongs to someone else (G3 re-check)', async () => {
      const repos = createMemoryRepositories();
      const { llm } = makeLlm({
        pending: 'answer_to_pending',
        selection: { kind: 'choose', choice: 2 },
      });
      const cancelOrder = spyCancel(repos);
      await putAwaitingSelection(repos);

      vi.spyOn(repos.orders, 'getOrder').mockResolvedValue({
        id: '1005',
        customerId: 'cust_002',
        status: 'processing',
        itemSummary: 'Wireless headphones',
        createdAt: '2026-10-06T09:00:00.000Z',
      });

      const response = await handleMessage(SESSION, 'the second one', { repos, llm });

      expect(response.answer).toBe(`FACTS: ${ORDER_NOT_FOUND_MESSAGE}`);
      expect(response.needsConfirmation).toBe(false);
      expect(await repos.sessions.getState(SESSION)).toEqual({ step: 'idle' });
      expect(cancelOrder).not.toHaveBeenCalled();
    });
  });
});
