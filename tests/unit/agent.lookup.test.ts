// Unit tests for the order_lookup branch of handleMessage.
// In-memory repositories and a fake llm: no network, no env vars.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Relative imports on purpose: the "@/*" alias is a tsconfig path that Vitest
// does not resolve without extra config.
import { type Deps, handleMessage } from '../../src/lib/agent';
import { DEMO_CUSTOMER_ID } from '../../src/lib/config';
import { ORDER_NOT_FOUND_MESSAGE } from '../../src/lib/gates';
import { createMemoryRepositories } from '../../src/lib/repositories/memory';
import { ChatResponseSchema, type IntentClassification } from '../../src/lib/schema';

const SESSION = 'session-a';
const REPLY = 'phrased reply';

function fakeLlm(orderId: string | null): Deps['llm'] {
  const classification: IntentClassification = {
    intent: 'order_lookup',
    orderId,
    wantsHuman: false,
    isComplaint: false,
  };

  return {
    classifyIntent: vi.fn(() => Promise.resolve(classification)),
    writeReply: vi.fn(() => Promise.resolve(REPLY)),
  };
}

function deps(orderId: string | null) {
  return { repos: createMemoryRepositories(), llm: fakeLlm(orderId) };
}

/** The `facts` string handed to writeReply on its first call. */
function factsPassedTo(llm: Deps['llm']): string {
  const mock = vi.mocked(llm.writeReply);
  expect(mock).toHaveBeenCalledTimes(1);
  const call = mock.mock.calls[0];
  if (!call) throw new Error('writeReply was not called');
  return call[0].facts;
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('order_lookup - the response shape', () => {
  it('returns a schema-valid order_lookup response', async () => {
    const { repos, llm } = deps('1002');

    const response = await handleMessage(SESSION, 'where is my order 1002?', { repos, llm });

    expect(ChatResponseSchema.safeParse(response).success).toBe(true);
    expect(response).toEqual({
      answer: REPLY,
      intent: 'order_lookup',
      needsConfirmation: false,
      options: [],
      offerHandoff: false,
      sources: [],
    });
  });

  it('passes the customer message through to writeReply', async () => {
    const { repos, llm } = deps('1002');

    await handleMessage(SESSION, 'where is my order 1002?', { repos, llm });

    expect(vi.mocked(llm.writeReply).mock.calls[0]?.[0]).toMatchObject({
      intent: 'order_lookup',
      customerMessage: 'where is my order 1002?',
    });
  });
});

describe('order_lookup - an existing order', () => {
  it('builds facts from the order', async () => {
    const { repos, llm } = deps('1002');

    await handleMessage(SESSION, 'where is my order 1002?', { repos, llm });

    const facts = factsPassedTo(llm);
    expect(facts).toContain('Order 1002.');
    expect(facts).toContain('USB-C cable');
    expect(facts).toContain('shipped');
    expect(facts).toMatch(/Ordered on: \d{4}-\d{2}-\d{2}\./);
  });

  it('works for a cancelled order too', async () => {
    const { repos, llm } = deps('1004');

    await handleMessage(SESSION, 'what happened to 1004?', { repos, llm });

    const facts = factsPassedTo(llm);
    expect(facts).toContain('Order 1004.');
    expect(facts).toContain('Desk lamp');
    expect(facts).toContain('cancelled');
  });
});

describe('order_lookup - no order id given', () => {
  it('uses the most recent order, which is 1006 for cust_001', async () => {
    const { repos, llm } = deps(null);

    await handleMessage(SESSION, 'where is my order?', { repos, llm });

    const facts = factsPassedTo(llm);
    expect(facts).toContain('Order 1006.');
    expect(facts).toContain('Wireless headphones');
    expect(facts).toContain('processing');
  });

  it('adds the most-recent-order fact and the invitation to send a number', async () => {
    const { repos, llm } = deps(null);

    await handleMessage(SESSION, 'where is my order?', { repos, llm });

    const facts = factsPassedTo(llm);
    expect(facts).toContain('most recent order');
    expect(facts).toContain('did not give an order number');
    expect(facts).toContain('4-digit');
  });

  it('calls getLatestOrder with the demo customer', async () => {
    const { repos, llm } = deps(null);
    const getLatestOrder = vi.spyOn(repos.orders, 'getLatestOrder');

    await handleMessage(SESSION, 'where is my order?', { repos, llm });

    expect(getLatestOrder).toHaveBeenCalledWith(DEMO_CUSTOMER_ID);
  });

  it('tells the model the customer has no orders when there are none', async () => {
    const { repos, llm } = deps(null);
    vi.spyOn(repos.orders, 'getLatestOrder').mockResolvedValue(null);

    const response = await handleMessage(SESSION, 'where is my order?', { repos, llm });

    const facts = factsPassedTo(llm);
    expect(facts).toBe('The customer has no orders at all.');
    expect(facts).not.toContain('most recent');
    expect(response.intent).toBe('order_lookup');
  });
});

describe('order_lookup - a malformed order id (G1)', () => {
  it('reports the format problem instead of looking anything up', async () => {
    const { repos, llm } = deps('12');

    await handleMessage(SESSION, 'where is my order 12?', { repos, llm });

    expect(factsPassedTo(llm)).toBe('Order numbers are four digits, like 1002.');
  });

  it('NEVER falls back to the most recent order', async () => {
    const { repos, llm } = deps('12');
    const getLatestOrder = vi.spyOn(repos.orders, 'getLatestOrder');

    await handleMessage(SESSION, 'where is my order 12?', { repos, llm });

    expect(getLatestOrder).not.toHaveBeenCalled();
    expect(factsPassedTo(llm)).not.toContain('1006');
    expect(factsPassedTo(llm)).toBe('Order numbers are four digits, like 1002.');
  });

  it('does not fall back for an empty-string order id either', async () => {
    const { repos, llm } = deps('');
    const getLatestOrder = vi.spyOn(repos.orders, 'getLatestOrder');

    await handleMessage(SESSION, 'where is my order?', { repos, llm });

    expect(getLatestOrder).toHaveBeenCalled();
    expect(factsPassedTo(llm)).toContain('most recent order');
  });
});

describe('order_lookup - not found and not yours are indistinguishable', () => {
  it('reports a non-existent order as not found', async () => {
    const { repos, llm } = deps('9999');

    await handleMessage(SESSION, 'where is my order 9999?', { repos, llm });

    expect(factsPassedTo(llm)).toBe(ORDER_NOT_FOUND_MESSAGE);
  });

  it("reports another customer's order with IDENTICAL facts", async () => {
    const missing = deps('9999');
    await handleMessage(SESSION, 'where is my order 9999?', {
      repos: missing.repos,
      llm: missing.llm,
    });

    // 2001 exists, but it belongs to cust_002.
    const someoneElses = deps('2001');
    await handleMessage(SESSION, 'where is my order 2001?', {
      repos: someoneElses.repos,
      llm: someoneElses.llm,
    });

    expect(factsPassedTo(someoneElses.llm)).toBe(factsPassedTo(missing.llm));
  });

  it("leaks nothing about the other customer's order to the llm", async () => {
    const { repos, llm } = deps('2001');

    await handleMessage(SESSION, 'where is my order 2001?', { repos, llm });

    // Everything handed to the model, not just the facts.
    const everything = JSON.stringify(vi.mocked(llm.writeReply).mock.calls);
    expect(everything).not.toContain('Yoga mat');
    expect(everything).not.toContain('cust_002');
    expect(everything).not.toContain('processing');
    expect(factsPassedTo(llm)).toBe(ORDER_NOT_FOUND_MESSAGE);
  });

  it('still lets the real owner see that order', async () => {
    const { repos, llm } = deps('2001');

    // getOrder is shared, so prove the block is about ownership, not the row.
    const order = await repos.orders.getOrder('2001');

    expect(order?.customerId).toBe('cust_002');
    await handleMessage(SESSION, 'where is my order 2001?', { repos, llm });
    expect(factsPassedTo(llm)).toBe(ORDER_NOT_FOUND_MESSAGE);
  });
});

describe('order_lookup - no writes', () => {
  it('writes no session state and creates no ticket', async () => {
    const { repos, llm } = deps('1002');
    const setState = vi.spyOn(repos.sessions, 'setState');

    await handleMessage(SESSION, 'where is my order 1002?', { repos, llm });

    expect(setState).not.toHaveBeenCalled();
    expect(repos.handoffTickets).toEqual([]);
  });
});
