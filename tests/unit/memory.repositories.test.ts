// Unit tests for the in-memory repositories. No network, no database.

import { describe, expect, it } from 'vitest';

// Relative import on purpose: the "@/*" alias is a tsconfig path that Vitest
// does not resolve without extra config, and this step adds no config.
import { createMemoryRepositories } from '../../src/lib/repositories/memory';

describe('createMemoryRepositories - seed data', () => {
  it('seeds the same demo orders as supabase/seed.sql', async () => {
    const repos = createMemoryRepositories();

    const ids = await Promise.all(
      ['1001', '1002', '1003', '1004', '1005', '1006', '2001', '2002'].map((id) =>
        repos.orders.getOrder(id),
      ),
    );

    expect(ids.every((order) => order !== null)).toBe(true);
    expect(await repos.orders.getOrder('9999')).toBeNull();
  });

  it('gives 1005 and 1006 the same item name but different dates', async () => {
    const repos = createMemoryRepositories();

    const a = await repos.orders.getOrder('1005');
    const b = await repos.orders.getOrder('1006');

    expect(a?.itemSummary).toBe('Wireless headphones');
    expect(b?.itemSummary).toBe(a?.itemSummary);
    expect(b?.createdAt).not.toBe(a?.createdAt);
  });

  it('does not filter getOrder by customer - gate G3 is the caller\'s job', async () => {
    const repos = createMemoryRepositories();

    const other = await repos.orders.getOrder('2001');

    expect(other?.customerId).toBe('cust_002');
  });
});

describe('getLatestOrder', () => {
  it('returns 1006 for cust_001', async () => {
    const repos = createMemoryRepositories();

    const latest = await repos.orders.getLatestOrder('cust_001');

    expect(latest?.id).toBe('1006');
  });

  it('still returns 1006 for cust_001 once it is cancelled - any status counts', async () => {
    const repos = createMemoryRepositories();

    expect(await repos.orders.cancelOrder('1006')).toEqual({ ok: true });
    const latest = await repos.orders.getLatestOrder('cust_001');

    expect(latest?.id).toBe('1006');
    expect(latest?.status).toBe('cancelled');
  });

  it('returns 2001 for cust_002', async () => {
    const repos = createMemoryRepositories();

    const latest = await repos.orders.getLatestOrder('cust_002');

    expect(latest?.id).toBe('2001');
  });

  it('returns null for an unknown customer', async () => {
    const repos = createMemoryRepositories();

    expect(await repos.orders.getLatestOrder('cust_999')).toBeNull();
  });
});

describe('getCancellableOrders', () => {
  it('returns only processing orders, oldest first', async () => {
    const repos = createMemoryRepositories();

    const cancellable = await repos.orders.getCancellableOrders('cust_001');

    expect(cancellable.map((order) => order.id)).toEqual(['1003', '1005', '1006']);
    expect(cancellable.every((order) => order.status === 'processing')).toBe(true);
  });

  it('never includes another customer\'s orders', async () => {
    const repos = createMemoryRepositories();

    const forCust001 = await repos.orders.getCancellableOrders('cust_001');

    expect(forCust001.every((order) => order.customerId === 'cust_001')).toBe(true);
    expect(forCust001.map((order) => order.id)).not.toContain('2001');
    expect(forCust001.map((order) => order.id)).not.toContain('2002');
  });

  it('returns cust_002 only its own processing order', async () => {
    const repos = createMemoryRepositories();

    const cancellable = await repos.orders.getCancellableOrders('cust_002');

    expect(cancellable.map((order) => order.id)).toEqual(['2001']);
  });

  it('returns an empty array for an unknown customer', async () => {
    const repos = createMemoryRepositories();

    expect(await repos.orders.getCancellableOrders('cust_999')).toEqual([]);
  });

  it('drops an order once it is cancelled', async () => {
    const repos = createMemoryRepositories();

    await repos.orders.cancelOrder('1003');
    const cancellable = await repos.orders.getCancellableOrders('cust_001');

    expect(cancellable.map((order) => order.id)).toEqual(['1005', '1006']);
  });
});

describe('cancelOrder', () => {
  it('cancels a processing order and sets the status to cancelled', async () => {
    const repos = createMemoryRepositories();

    expect(await repos.orders.cancelOrder('1005')).toEqual({ ok: true });
    expect((await repos.orders.getOrder('1005'))?.status).toBe('cancelled');
  });

  it('fails the second time with not_cancellable', async () => {
    const repos = createMemoryRepositories();

    expect(await repos.orders.cancelOrder('1005')).toEqual({ ok: true });
    expect(await repos.orders.cancelOrder('1005')).toEqual({
      ok: false,
      reason: 'not_cancellable',
    });
  });

  it('refuses an order that was never processing', async () => {
    const repos = createMemoryRepositories();

    expect(await repos.orders.cancelOrder('1001')).toEqual({
      ok: false,
      reason: 'not_cancellable',
    });
    expect(await repos.orders.cancelOrder('1004')).toEqual({
      ok: false,
      reason: 'not_cancellable',
    });
  });

  it('reports not_found for an unknown order', async () => {
    const repos = createMemoryRepositories();

    expect(await repos.orders.cancelOrder('9999')).toEqual({
      ok: false,
      reason: 'not_found',
    });
  });
});

describe('SessionStore', () => {
  it('returns idle when nothing is stored', async () => {
    const repos = createMemoryRepositories();

    expect(await repos.sessions.getState('session-a')).toEqual({ step: 'idle' });
  });

  it('round-trips a stored state', async () => {
    const repos = createMemoryRepositories();

    await repos.sessions.setState('session-a', 'cust_001', {
      step: 'awaiting_confirmation',
      selectedOrderId: '1005',
      retries: 0,
    });

    expect(await repos.sessions.getState('session-a')).toEqual({
      step: 'awaiting_confirmation',
      selectedOrderId: '1005',
      retries: 0,
    });
  });

  it('overwrites on the second setState - it is an upsert', async () => {
    const repos = createMemoryRepositories();

    await repos.sessions.setState('session-a', 'cust_001', {
      step: 'awaiting_order_selection',
      candidateOrders: [{ n: 1, id: '1003', label: 'Phone case (ordered Oct 3)' }],
      retries: 2,
    });
    await repos.sessions.setState('session-a', 'cust_001', { step: 'idle' });

    expect(await repos.sessions.getState('session-a')).toEqual({ step: 'idle' });
  });

  it('keeps sessions separate from each other', async () => {
    const repos = createMemoryRepositories();

    await repos.sessions.setState('session-a', 'cust_001', { step: 'awaiting_confirmation' });

    expect(await repos.sessions.getState('session-b')).toEqual({ step: 'idle' });
  });
});

describe('HandoffRepository', () => {
  it('records a ticket that tests can inspect', async () => {
    const repos = createMemoryRepositories();

    await repos.handoffs.create('session-a', 'cust_001', 'My desk lamp arrived broken');

    expect(repos.handoffTickets).toHaveLength(1);
    expect(repos.handoffTickets[0]).toMatchObject({
      sessionId: 'session-a',
      customerId: 'cust_001',
      message: 'My desk lamp arrived broken',
    });
  });

  it('appends tickets oldest first', async () => {
    const repos = createMemoryRepositories();

    await repos.handoffs.create('session-a', 'cust_001', 'first');
    await repos.handoffs.create('session-b', 'cust_002', 'second');

    expect(repos.handoffTickets.map((ticket) => ticket.message)).toEqual(['first', 'second']);
  });

  it('starts with no tickets', () => {
    const repos = createMemoryRepositories();

    expect(repos.handoffTickets).toEqual([]);
  });
});

describe('isolation between instances', () => {
  it('does not share orders', async () => {
    const a = createMemoryRepositories();
    const b = createMemoryRepositories();

    await a.orders.cancelOrder('1005');

    expect((await a.orders.getOrder('1005'))?.status).toBe('cancelled');
    expect((await b.orders.getOrder('1005'))?.status).toBe('processing');
    expect(await b.orders.cancelOrder('1005')).toEqual({ ok: true });
  });

  it('does not share session state', async () => {
    const a = createMemoryRepositories();
    const b = createMemoryRepositories();

    await a.sessions.setState('session-a', 'cust_001', { step: 'awaiting_confirmation' });

    expect(await b.sessions.getState('session-a')).toEqual({ step: 'idle' });
  });

  it('does not share handoff tickets', async () => {
    const a = createMemoryRepositories();
    const b = createMemoryRepositories();

    await a.handoffs.create('session-a', 'cust_001', 'only in a');

    expect(a.handoffTickets).toHaveLength(1);
    expect(b.handoffTickets).toHaveLength(0);
  });

  it('hands out copies, so a caller cannot mutate stored rows', async () => {
    const repos = createMemoryRepositories();

    const order = await repos.orders.getOrder('1005');
    if (order) order.status = 'delivered';

    expect((await repos.orders.getOrder('1005'))?.status).toBe('processing');
  });
});
