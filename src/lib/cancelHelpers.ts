// Pure helpers for the cancel flow's order-selection step.
// No I/O, no LLM, no state.
//
// The one rule behind all of this: the LLM sees NUMBERS and LABELS, never a
// real order id. The code keeps the ids and maps a number back to one.

import { gateChoiceInRange } from './gates';
import type { CandidateOrder, Order } from './repositories/types';

/** Short English months. Fixed here so the label never depends on a locale. */
const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

/** "Oct 5" from an ISO timestamp, read in UTC so it never shifts by timezone. */
function shortDate(createdAt: string): string {
  const date = new Date(createdAt);
  return `${MONTHS[date.getUTCMonth()] ?? '?'} ${String(date.getUTCDate())}`;
}

/** "Wireless headphones (ordered Oct 5)" - item and date only, never the id. */
function baseLabel(order: Order): string {
  return `${order.itemSummary} (ordered ${shortDate(order.createdAt)})`;
}

/**
 * Number the orders 1..N and give each a human label.
 *
 * Two orders of the same item on the same day would produce the same label, so
 * those get " - 1 of 2" / " - 2 of 2" appended. Without that the customer could
 * not tell the options apart, and a choice would be ambiguous.
 */
export function buildCandidateOrders(orders: Order[]): CandidateOrder[] {
  const counts = new Map<string, number>();
  for (const order of orders) {
    const label = baseLabel(order);
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }

  const seen = new Map<string, number>();

  return orders.map((order, index) => {
    const base = baseLabel(order);
    const total = counts.get(base) ?? 1;

    let label = base;
    if (total > 1) {
      const position = (seen.get(base) ?? 0) + 1;
      seen.set(base, position);
      label = `${base} - ${String(position)} of ${String(total)}`;
    }

    return { n: index + 1, id: order.id, label };
  });
}

/**
 * The `options` for the response: the temporary number as a string, plus the
 * label. The real order id is deliberately left out.
 */
export function toOptions(candidates: CandidateOrder[]): { id: string; label: string }[] {
  return candidates.map((candidate) => ({ id: String(candidate.n), label: candidate.label }));
}

/**
 * Map a number the customer chose back to the real candidate.
 *
 * Range checking is gate G5, reused here so there is one definition of "a
 * valid choice". Returns null when the number is not usable.
 */
export function resolveChoice(candidates: CandidateOrder[], choice: number): CandidateOrder | null {
  if (!gateChoiceInRange(choice, candidates.length).ok) return null;
  return candidates[choice - 1] ?? null;
}

/** The numbered list shown to the LLM. Labels only - no order ids. */
export function labelsForLlm(candidates: CandidateOrder[]): string {
  return candidates.map((candidate) => `${String(candidate.n)}) ${candidate.label}`).join('\n');
}
