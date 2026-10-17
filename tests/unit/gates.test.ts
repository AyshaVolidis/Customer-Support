// Unit tests for the gates. Pure functions, so no mocks and no I/O.

import { describe, expect, it } from 'vitest';

// Relative imports on purpose: the "@/*" alias is a tsconfig path that Vitest
// does not resolve without extra config.
import { MAX_MESSAGE_LENGTH } from '../../src/lib/config';
import {
  GateResult,
  ORDER_NOT_FOUND_MESSAGE,
  gateChoiceInRange,
  gateConfirmed,
  gateMessage,
  gateOrderBelongsToCustomer,
  gateOrderCancellable,
  gateOrderIdFormat,
} from '../../src/lib/gates';
import type { Order, OrderStatus } from '../../src/lib/repositories/types';

function order(overrides: Partial<Order> = {}): Order {
  return {
    id: '1005',
    customerId: 'cust_001',
    status: 'processing',
    itemSummary: 'Wireless headphones',
    createdAt: '2026-10-06T09:00:00.000Z',
    ...overrides,
  };
}

/** Narrow a failing result so reason/userMessage are accessible. */
function expectFail(result:GateResult) {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error('expected a failing gate result');
  return result;
}

describe('gateOrderIdFormat (G1)', () => {
  it('accepts exactly four digits', () => {
    expect(gateOrderIdFormat('1002').ok).toBe(true);
    expect(gateOrderIdFormat('0000').ok).toBe(true);
    expect(gateOrderIdFormat('9999').ok).toBe(true);
  });

  it('rejects a padded id like " 1002 " - the id is not trimmed first', () => {
    expect(gateOrderIdFormat(' 1002 ').ok).toBe(false);
    expect(gateOrderIdFormat('1002 ').ok).toBe(false);
    expect(gateOrderIdFormat(' 1002').ok).toBe(false);
  });

  it('rejects too many digits', () => {
    expect(gateOrderIdFormat('12345').ok).toBe(false);
  });

  it('rejects too few digits', () => {
    expect(gateOrderIdFormat('123').ok).toBe(false);
    expect(gateOrderIdFormat('1').ok).toBe(false);
  });

  it('rejects Arabic-Indic digits', () => {
    // U+0661 U+0660 U+0660 U+0662 - looks like 1002 but is not ASCII.
    expect(gateOrderIdFormat('١٠٠٢').ok).toBe(false);
  });

  it('rejects Eastern Arabic (Persian) digits', () => {
    expect(gateOrderIdFormat('۱۰۰۲').ok).toBe(false);
  });

  it('rejects an empty string', () => {
    expect(gateOrderIdFormat('').ok).toBe(false);
  });

  it('rejects letters, punctuation and embedded whitespace', () => {
    expect(gateOrderIdFormat('100a').ok).toBe(false);
    expect(gateOrderIdFormat('10 2').ok).toBe(false);
    expect(gateOrderIdFormat('1.02').ok).toBe(false);
    expect(gateOrderIdFormat('+100').ok).toBe(false);
    expect(gateOrderIdFormat('#1002').ok).toBe(false);
  });

  it('rejects a trailing newline', () => {
    expect(gateOrderIdFormat('1002\n').ok).toBe(false);
  });

  it('explains the format to the customer', () => {
    const failed = expectFail(gateOrderIdFormat('12'));

    expect(failed.reason).toBe('order_id_format');
    expect(failed.userMessage).toContain('four digits');
  });
});

describe('gateOrderBelongsToCustomer (G3)', () => {
  it('accepts the customer\'s own order', () => {
    expect(gateOrderBelongsToCustomer(order(), 'cust_001').ok).toBe(true);
  });

  it('rejects another customer\'s order', () => {
    expect(gateOrderBelongsToCustomer(order({ customerId: 'cust_002' }), 'cust_001').ok).toBe(
      false,
    );
  });

  it('replies exactly as if the order did not exist', () => {
    const failed = expectFail(
      gateOrderBelongsToCustomer(order({ customerId: 'cust_002' }), 'cust_001'),
    );

    expect(failed.userMessage).toBe(ORDER_NOT_FOUND_MESSAGE);
    // The internal reason may differ; it is never shown to the customer.
    expect(failed.reason).toBe('order_other_customer');
  });

  it('is case- and whitespace-sensitive about the customer id', () => {
    expect(gateOrderBelongsToCustomer(order(), 'CUST_001').ok).toBe(false);
    expect(gateOrderBelongsToCustomer(order(), ' cust_001').ok).toBe(false);
  });
});

describe('gateOrderCancellable (G4)', () => {
  it('accepts a processing order', () => {
    expect(gateOrderCancellable(order({ status: 'processing' })).ok).toBe(true);
  });

  it('rejects a shipped order and says why', () => {
    const failed = expectFail(gateOrderCancellable(order({ status: 'shipped' })));

    expect(failed.reason).toBe('order_not_cancellable');
    expect(failed.userMessage).toContain('shipped');
  });

  it('rejects a delivered order and says why', () => {
    const failed = expectFail(gateOrderCancellable(order({ status: 'delivered' })));

    expect(failed.reason).toBe('order_not_cancellable');
    expect(failed.userMessage).toContain('delivered');
  });

  it('rejects an already cancelled order and says so', () => {
    const failed = expectFail(gateOrderCancellable(order({ status: 'cancelled' })));

    expect(failed.reason).toBe('order_already_cancelled');
    expect(failed.userMessage).toContain('already cancelled');
  });

  it('rejects every status except processing', () => {
    const statuses: OrderStatus[] = ['shipped', 'delivered', 'cancelled'];

    for (const status of statuses) {
      expect(gateOrderCancellable(order({ status })).ok).toBe(false);
    }
  });
});

describe('gateChoiceInRange (G5)', () => {
  it('accepts the first and last option', () => {
    expect(gateChoiceInRange(1, 3).ok).toBe(true);
    expect(gateChoiceInRange(3, 3).ok).toBe(true);
    expect(gateChoiceInRange(1, 1).ok).toBe(true);
  });

  it('rejects 0 - options are 1-based', () => {
    expect(gateChoiceInRange(0, 3).ok).toBe(false);
  });

  it('rejects a choice past the end', () => {
    expect(gateChoiceInRange(4, 3).ok).toBe(false);
  });

  it('rejects a negative choice', () => {
    expect(gateChoiceInRange(-1, 3).ok).toBe(false);
  });

  it('rejects a non-integer choice', () => {
    expect(gateChoiceInRange(1.5, 3).ok).toBe(false);
    expect(gateChoiceInRange(2.000001, 3).ok).toBe(false);
  });

  it('rejects null', () => {
    expect(gateChoiceInRange(null, 3).ok).toBe(false);
  });

  it('rejects NaN and Infinity', () => {
    expect(gateChoiceInRange(Number.NaN, 3).ok).toBe(false);
    expect(gateChoiceInRange(Number.POSITIVE_INFINITY, 3).ok).toBe(false);
  });

  it('rejects anything when there are no options', () => {
    expect(gateChoiceInRange(1, 0).ok).toBe(false);
    expect(gateChoiceInRange(0, 0).ok).toBe(false);
  });

  it('asks for a number', () => {
    const failed = expectFail(gateChoiceInRange(9, 3));

    expect(failed.reason).toBe('choice_out_of_range');
    expect(failed.userMessage).toContain('number');
  });
});

describe('gateConfirmed (G6)', () => {
  it('accepts only yes', () => {
    expect(gateConfirmed('yes').ok).toBe(true);
  });

  // The reply is binary (Q8): an unclear answer reaches this gate as 'no',
  // so 'no' is the only rejection there is.
  it('rejects no, and says nothing was cancelled', () => {
    const failed = expectFail(gateConfirmed('no'));

    expect(failed.reason).toBe('declined');
    expect(failed.userMessage).toContain('Nothing was cancelled');
  });
});

describe('gateMessage (G9)', () => {
  const session = 'session-a';

  it('accepts a normal message', () => {
    expect(gateMessage('where is my order 1002?', session).ok).toBe(true);
  });

  it('rejects an empty message', () => {
    expect(gateMessage('', session).ok).toBe(false);
  });

  it('rejects a whitespace-only message', () => {
    expect(gateMessage('   ', session).ok).toBe(false);
    expect(gateMessage('\n\t  \r\n', session).ok).toBe(false);
  });

  it('accepts a message exactly at the limit', () => {
    expect(gateMessage('x'.repeat(MAX_MESSAGE_LENGTH), session).ok).toBe(true);
  });

  it('rejects a message one character over the limit', () => {
    const failed = expectFail(gateMessage('x'.repeat(MAX_MESSAGE_LENGTH + 1), session));

    expect(failed.reason).toBe('message_too_long');
    expect(failed.userMessage).toContain(String(MAX_MESSAGE_LENGTH));
  });

  it('rejects 501 characters when the limit is 500', () => {
    expect(MAX_MESSAGE_LENGTH).toBe(500);
    expect(gateMessage('x'.repeat(501), session).ok).toBe(false);
  });

  it('rejects a missing sessionId', () => {
    const failed = expectFail(gateMessage('hello', ''));

    expect(failed.reason).toBe('missing_session');
  });

  it('rejects a whitespace-only sessionId', () => {
    expect(gateMessage('hello', '   ').ok).toBe(false);
  });

  it('checks the sessionId before the message', () => {
    const failed = expectFail(gateMessage('', ''));

    expect(failed.reason).toBe('missing_session');
  });

  it('accepts an Arabic message', () => {
    expect(gateMessage('وين طلبي؟', session).ok).toBe(true);
  });
});
