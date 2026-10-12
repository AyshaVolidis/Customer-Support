// Unit tests for lookupOrder, against the in-memory repositories. No network.

import { afterEach, describe, expect, it, vi } from 'vitest';

// Relative imports on purpose: the "@/*" alias is a tsconfig path that Vitest
// does not resolve without extra config.
import { ORDER_NOT_FOUND_MESSAGE } from '../../src/lib/gates';
import { createMemoryRepositories } from '../../src/lib/repositories/memory';
import { lookupOrder } from '../../src/lib/tools';

const CUSTOMER = 'cust_001';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('lookupOrder - the customer\'s own order', () => {
  it('returns an existing order', async () => {
    const repos = createMemoryRepositories();

    const result = await lookupOrder({
      orderId: '1002',
      customerId: CUSTOMER,
      orders: repos.orders,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected a successful lookup');
    expect(result.order.id).toBe('1002');
    expect(result.order.customerId).toBe(CUSTOMER);
    expect(result.order.itemSummary).toBe('USB-C cable');
  });

  it('works for any status, not just processing', async () => {
    const repos = createMemoryRepositories();

    // 1004 is cancelled, 1001 is delivered - a lookup must still find them.
    const cancelled = await lookupOrder({
      orderId: '1004',
      customerId: CUSTOMER,
      orders: repos.orders,
    });
    const delivered = await lookupOrder({
      orderId: '1001',
      customerId: CUSTOMER,
      orders: repos.orders,
    });

    expect(cancelled.ok).toBe(true);
    expect(delivered.ok).toBe(true);
  });
});

describe('lookupOrder - bad format (G1)', () => {
  it('rejects "12"', async () => {
    const repos = createMemoryRepositories();

    const result = await lookupOrder({ orderId: '12', customerId: CUSTOMER, orders: repos.orders });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected a failed lookup');
    expect(result.reason).toBe('order_id_format');
    expect(result.userMessage).toContain('four digits');
  });

  it('rejects "10025"', async () => {
    const repos = createMemoryRepositories();

    const result = await lookupOrder({
      orderId: '10025',
      customerId: CUSTOMER,
      orders: repos.orders,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected a failed lookup');
    expect(result.reason).toBe('order_id_format');
  });

  it('rejects Arabic-Indic digits', async () => {
    const repos = createMemoryRepositories();

    const result = await lookupOrder({
      orderId: '١٠٠٢',
      customerId: CUSTOMER,
      orders: repos.orders,
    });

    expect(result.ok).toBe(false);
  });

  it('does not touch the repository when the format is wrong', async () => {
    const repos = createMemoryRepositories();
    const getOrder = vi.spyOn(repos.orders, 'getOrder');

    await lookupOrder({ orderId: '12', customerId: CUSTOMER, orders: repos.orders });

    expect(getOrder).not.toHaveBeenCalled();
  });
});

describe('lookupOrder - not found (G2) and not yours (G3) are indistinguishable', () => {
  it('reports a non-existent order as not found', async () => {
    const repos = createMemoryRepositories();

    const result = await lookupOrder({
      orderId: '9999',
      customerId: CUSTOMER,
      orders: repos.orders,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected a failed lookup');
    expect(result.reason).toBe('order_not_found');
    expect(result.userMessage).toBe(ORDER_NOT_FOUND_MESSAGE);
  });

  it('reports another customer\'s order as not found', async () => {
    const repos = createMemoryRepositories();

    // 2001 exists, but it belongs to cust_002.
    const result = await lookupOrder({
      orderId: '2001',
      customerId: CUSTOMER,
      orders: repos.orders,
    });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected a failed lookup');
    expect(result.reason).toBe('order_not_found');
    expect(result.userMessage).toBe(ORDER_NOT_FOUND_MESSAGE);
  });
  
  // No information leak
  it('returns byte-identical results for both cases', async () => {
    const repos = createMemoryRepositories();

    const missing = await lookupOrder({
      orderId: '9999',
      customerId: CUSTOMER,
      orders: repos.orders,
    });
    const someoneElses = await lookupOrder({
      orderId: '2001',
      customerId: CUSTOMER,
      orders: repos.orders,
    });

    expect(someoneElses).toEqual(missing);
    expect(JSON.stringify(someoneElses)).toBe(JSON.stringify(missing));
  });

  it('never leaks the other customer\'s order details', async () => {
    const repos = createMemoryRepositories();

    const result = await lookupOrder({
      orderId: '2001',
      customerId: CUSTOMER,
      orders: repos.orders,
    });

    const serialised = JSON.stringify(result);
    expect(serialised).not.toContain('cust_002');
    expect(serialised).not.toContain('Yoga mat');
    expect(serialised).not.toContain('2001');
  });

  it('lets the real owner see that same order', async () => {
    const repos = createMemoryRepositories();

    const result = await lookupOrder({
      orderId: '2001',
      customerId: 'cust_002',
      orders: repos.orders,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected a successful lookup');
    expect(result.order.itemSummary).toBe('Yoga mat');
  });
});
