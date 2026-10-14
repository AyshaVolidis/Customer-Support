// Unit tests for the cancel flow's pure helpers. No mocks, no I/O.

import { describe, expect, it } from 'vitest';

// Relative imports on purpose: the "@/*" alias is a tsconfig path that Vitest
// does not resolve without extra config.
import {
  buildCandidateOrders,
  labelsForLlm,
  resolveChoice,
  toOptions,
} from '../../src/lib/cancelHelpers';
import type { Order } from '../../src/lib/repositories/types';

/** A processing order. Dates are fixed UTC strings so labels are deterministic. */
function order(id: string, itemSummary: string, createdAt: string): Order {
  return { id, customerId: 'cust_001', status: 'processing', itemSummary, createdAt };
}

/** The three cancellable orders of cust_001, as seeded: oldest first. */
function seededCancellable(): Order[] {
  return [
    order('1003', 'Phone case', '2026-10-03T09:07:59.829Z'),
    order('1005', 'Wireless headphones', '2026-10-06T09:07:59.829Z'),
    order('1006', 'Wireless headphones', '2026-10-09T09:07:59.829Z'),
  ];
}

describe('buildCandidateOrders - numbering', () => {
  it('numbers the orders 1..N in the order given', () => {
    const candidates = buildCandidateOrders(seededCancellable());

    expect(candidates.map((c) => c.n)).toEqual([1, 2, 3]);
  });

  it('keeps the real order id on each candidate', () => {
    const candidates = buildCandidateOrders(seededCancellable());

    expect(candidates.map((c) => c.id)).toEqual(['1003', '1005', '1006']);
  });

  it('returns an empty array for no orders', () => {
    expect(buildCandidateOrders([])).toEqual([]);
  });

  it('numbers a single order as 1', () => {
    const candidates = buildCandidateOrders([order('1003', 'Phone case', '2026-10-03T00:00:00Z')]);

    expect(candidates).toEqual([
      { n: 1, id: '1003', label: 'Phone case (ordered Oct 3)' },
    ]);
  });
});

describe('buildCandidateOrders - the label', () => {
  it('is "item (ordered Mon D)"', () => {
    const candidates = buildCandidateOrders(seededCancellable());

    expect(candidates[0]?.label).toBe('Phone case (ordered Oct 3)');
    expect(candidates[1]?.label).toBe('Wireless headphones (ordered Oct 6)');
    expect(candidates[2]?.label).toBe('Wireless headphones (ordered Oct 9)');
  });

  it('uses the UTC date, not the local one', () => {
    // 23:30 UTC stays the 3rd even if the machine is hours ahead or behind.
    const candidates = buildCandidateOrders([
      order('1003', 'Phone case', '2026-10-03T23:30:00.000Z'),
    ]);

    expect(candidates[0]?.label).toBe('Phone case (ordered Oct 3)');
  });

  it('formats a January date as Jan', () => {
    const candidates = buildCandidateOrders([order('1009', 'Desk mat', '2026-01-09T10:00:00Z')]);

    expect(candidates[0]?.label).toBe('Desk mat (ordered Jan 9)');
  });
});

describe('buildCandidateOrders - duplicate item names', () => {
  it('gives 1005 and 1006 different labels (their dates differ)', () => {
    const candidates = buildCandidateOrders(seededCancellable());

    const headphones = candidates.filter((c) => c.label.startsWith('Wireless headphones'));
    expect(headphones).toHaveLength(2);
    expect(headphones[0]?.label).not.toBe(headphones[1]?.label);
  });

  it('adds "- 1 of 2" / "- 2 of 2" when item AND date are the same', () => {
    const candidates = buildCandidateOrders([
      order('1005', 'Wireless headphones', '2026-10-06T08:00:00Z'),
      order('1006', 'Wireless headphones', '2026-10-06T19:00:00Z'),
    ]);

    expect(candidates[0]?.label).toBe('Wireless headphones (ordered Oct 6) - 1 of 2');
    expect(candidates[1]?.label).toBe('Wireless headphones (ordered Oct 6) - 2 of 2');
  });

  it('counts out of three when three collide', () => {
    const candidates = buildCandidateOrders([
      order('1005', 'Wireless headphones', '2026-10-06T01:00:00Z'),
      order('1006', 'Wireless headphones', '2026-10-06T02:00:00Z'),
      order('1007', 'Wireless headphones', '2026-10-06T03:00:00Z'),
    ]);

    expect(candidates.map((c) => c.label)).toEqual([
      'Wireless headphones (ordered Oct 6) - 1 of 3',
      'Wireless headphones (ordered Oct 6) - 2 of 3',
      'Wireless headphones (ordered Oct 6) - 3 of 3',
    ]);
  });

  it('leaves a non-colliding order in a mixed list unsuffixed', () => {
    const candidates = buildCandidateOrders([
      order('1003', 'Phone case', '2026-10-03T09:00:00Z'),
      order('1005', 'Wireless headphones', '2026-10-06T08:00:00Z'),
      order('1006', 'Wireless headphones', '2026-10-06T19:00:00Z'),
    ]);

    expect(candidates[0]?.label).toBe('Phone case (ordered Oct 3)');
    expect(candidates[1]?.label).toContain('1 of 2');
    expect(candidates[2]?.label).toContain('2 of 2');
  });

  it('makes every label unique', () => {
    const candidates = buildCandidateOrders([
      order('1005', 'Wireless headphones', '2026-10-06T08:00:00Z'),
      order('1006', 'Wireless headphones', '2026-10-06T19:00:00Z'),
    ]);

    const labels = candidates.map((c) => c.label);
    expect(new Set(labels).size).toBe(labels.length);
  });
});

describe('no order id ever reaches a label or the LLM string', () => {
  const lists: Order[][] = [
    seededCancellable(),
    [
      order('1005', 'Wireless headphones', '2026-10-06T08:00:00Z'),
      order('1006', 'Wireless headphones', '2026-10-06T19:00:00Z'),
    ],
    // An id-looking number in the item name would be the owner's own text,
    // but the label must still never carry THIS order's id.
    [order('1234', 'Cable 5678', '2026-10-06T08:00:00Z')],
  ];

  it('no label contains its own order id', () => {
    for (const orders of lists) {
      for (const candidate of buildCandidateOrders(orders)) {
        expect(candidate.label).not.toContain(candidate.id);
      }
    }
  });

  it('no label contains any order id from the list', () => {
    for (const orders of lists) {
      const candidates = buildCandidateOrders(orders);
      const ids = candidates.map((c) => c.id);

      for (const candidate of candidates) {
        for (const id of ids) {
          expect(candidate.label).not.toContain(id);
        }
      }
    }
  });

  it('labelsForLlm contains no order id', () => {
    for (const orders of lists) {
      const candidates = buildCandidateOrders(orders);
      const text = labelsForLlm(candidates);

      for (const candidate of candidates) {
        expect(text).not.toContain(candidate.id);
      }
    }
  });

  it('toOptions contains no order id', () => {
    for (const orders of lists) {
      const candidates = buildCandidateOrders(orders);
      const serialised = JSON.stringify(toOptions(candidates));

      for (const candidate of candidates) {
        expect(serialised).not.toContain(candidate.id);
      }
    }
  });
});

describe('toOptions', () => {
  it('uses the number as a string for id, and the label', () => {
    const candidates = buildCandidateOrders(seededCancellable());

    expect(toOptions(candidates)).toEqual([
      { id: '1', label: 'Phone case (ordered Oct 3)' },
      { id: '2', label: 'Wireless headphones (ordered Oct 6)' },
      { id: '3', label: 'Wireless headphones (ordered Oct 9)' },
    ]);
  });

  it('returns an empty array for no candidates', () => {
    expect(toOptions([])).toEqual([]);
  });
});

describe('labelsForLlm', () => {
  it('formats a numbered list, one per line', () => {
    const candidates = buildCandidateOrders(seededCancellable());

    expect(labelsForLlm(candidates)).toBe(
      '1) Phone case (ordered Oct 3)\n' +
        '2) Wireless headphones (ordered Oct 6)\n' +
        '3) Wireless headphones (ordered Oct 9)',
    );
  });

  it('returns an empty string for no candidates', () => {
    expect(labelsForLlm([])).toBe('');
  });
});

describe('resolveChoice', () => {
  it('returns the first and last candidate', () => {
    const candidates = buildCandidateOrders(seededCancellable());

    expect(resolveChoice(candidates, 1)?.id).toBe('1003');
    expect(resolveChoice(candidates, 3)?.id).toBe('1006');
  });

  it('returns null for 0', () => {
    expect(resolveChoice(buildCandidateOrders(seededCancellable()), 0)).toBeNull();
  });

  it('returns null for N+1', () => {
    expect(resolveChoice(buildCandidateOrders(seededCancellable()), 4)).toBeNull();
  });

  it('returns null for 1.5', () => {
    expect(resolveChoice(buildCandidateOrders(seededCancellable()), 1.5)).toBeNull();
  });

  it('returns null for a negative number, NaN and Infinity', () => {
    const candidates = buildCandidateOrders(seededCancellable());

    expect(resolveChoice(candidates, -1)).toBeNull();
    expect(resolveChoice(candidates, Number.NaN)).toBeNull();
    expect(resolveChoice(candidates, Number.POSITIVE_INFINITY)).toBeNull();
  });

  it('returns null when there are no candidates', () => {
    expect(resolveChoice([], 1)).toBeNull();
  });

  it('maps the number back to the right real id', () => {
    const candidates = buildCandidateOrders(seededCancellable());

    expect(resolveChoice(candidates, 2)).toEqual({
      n: 2,
      id: '1005',
      label: 'Wireless headphones (ordered Oct 6)',
    });
  });
});
