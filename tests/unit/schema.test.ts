// Unit tests for the Zod schemas. Shape and type only - gates are tested separately.

import { describe, expect, it } from 'vitest';

// Relative import on purpose: the "@/*" alias is a tsconfig path that Vitest
// does not resolve without extra config.
import {
  ChatResponseSchema,
  ConfirmationReplySchema,
  IntentClassificationSchema,
  IntentSchema,
  OrderSelectionSchema,
  PendingReplyClassificationSchema,
  PolicyAnswerSchema,
} from '../../src/lib/schema';

/** A copy of obj without one key, for "rejects a missing field" cases. */
function omit<T extends object, K extends keyof T>(obj: T, key: K): Omit<T, K> {
  const copy: Partial<T> = { ...obj };
  delete copy[key];
  return copy as Omit<T, K>;
}

describe('IntentSchema', () => {
  it('accepts each of the five intents', () => {
    for (const intent of [
      'policy_question',
      'order_lookup',
      'cancel_order',
      'human_handoff',
      'out_of_scope',
    ]) {
      expect(IntentSchema.safeParse(intent).success).toBe(true);
    }
  });

  it('rejects an intent outside the five', () => {
    expect(IntentSchema.safeParse('refund_request').success).toBe(false);
    expect(IntentSchema.safeParse('').success).toBe(false);
  });
});

describe('ChatResponseSchema', () => {
  const valid = {
    answer: 'Your order 1002 has shipped.',
    intent: 'order_lookup',
    needsConfirmation: false,
    options: [],
    offerHandoff: false,
    sources: [],
  };

  it('accepts a complete response', () => {
    expect(ChatResponseSchema.safeParse(valid).success).toBe(true);
  });

  it('accepts options and sources when present', () => {
    const result = ChatResponseSchema.safeParse({
      ...valid,
      intent: 'cancel_order',
      needsConfirmation: true,
      options: [
        { id: '1', label: 'Phone case (ordered Oct 3)' },
        { id: '2', label: 'Wireless headphones (ordered Oct 6)' },
      ],
      sources: ['returns.md'],
    });

    expect(result.success).toBe(true);
  });

  it('rejects a bad intent value', () => {
    expect(ChatResponseSchema.safeParse({ ...valid, intent: 'refund' }).success).toBe(false);
  });

  it('rejects a missing field', () => {
    expect(ChatResponseSchema.safeParse(omit(valid, 'offerHandoff')).success).toBe(false);
  });

  it('rejects wrong types', () => {
    expect(ChatResponseSchema.safeParse({ ...valid, needsConfirmation: 'no' }).success).toBe(false);
    expect(ChatResponseSchema.safeParse({ ...valid, sources: 'returns.md' }).success).toBe(false);
    expect(ChatResponseSchema.safeParse({ ...valid, answer: null }).success).toBe(false);
  });

  it('rejects an option that is missing its label', () => {
    expect(
      ChatResponseSchema.safeParse({ ...valid, options: [{ id: '1' }] }).success,
    ).toBe(false);
  });
});

describe('IntentClassificationSchema', () => {
  const valid = {
    intent: 'cancel_order',
    orderId: '1005',
    wantsHuman: false,
    isComplaint: false,
  };

  it('accepts a complete classification', () => {
    expect(IntentClassificationSchema.safeParse(valid).success).toBe(true);
  });

  it('accepts a null orderId', () => {
    expect(IntentClassificationSchema.safeParse({ ...valid, orderId: null }).success).toBe(true);
  });

  // The schema checks shape only. "12" is the wrong FORMAT for an order id, but
  // that is gate G1's job in code - the schema must still accept it, so the code
  // sees what the customer actually wrote.
  it('accepts a badly formatted orderId like "12" - format is gate G1, not the schema', () => {
    expect(IntentClassificationSchema.safeParse({ ...valid, orderId: '12' }).success).toBe(true);
    expect(IntentClassificationSchema.safeParse({ ...valid, orderId: 'abcd' }).success).toBe(true);
  });

  it('rejects an orderId longer than 20 characters', () => {
    expect(
      IntentClassificationSchema.safeParse({ ...valid, orderId: '1'.repeat(21) }).success,
    ).toBe(false);
    expect(
      IntentClassificationSchema.safeParse({ ...valid, orderId: '1'.repeat(20) }).success,
    ).toBe(true);
  });

  it('rejects a bad intent value', () => {
    expect(IntentClassificationSchema.safeParse({ ...valid, intent: 'chitchat' }).success).toBe(
      false,
    );
  });

  it('rejects a missing orderId key - null must be explicit', () => {
    expect(IntentClassificationSchema.safeParse(omit(valid, 'orderId')).success).toBe(false);
  });

  it('rejects a non-boolean flag', () => {
    expect(IntentClassificationSchema.safeParse({ ...valid, wantsHuman: 'yes' }).success).toBe(
      false,
    );
  });
});

describe('PendingReplyClassificationSchema', () => {
  it('accepts both kinds', () => {
    expect(PendingReplyClassificationSchema.safeParse({ kind: 'answer_to_pending' }).success).toBe(
      true,
    );
    expect(PendingReplyClassificationSchema.safeParse({ kind: 'new_topic' }).success).toBe(true);
  });

  it('rejects anything else', () => {
    expect(PendingReplyClassificationSchema.safeParse({ kind: 'maybe' }).success).toBe(false);
    expect(PendingReplyClassificationSchema.safeParse({}).success).toBe(false);
  });
});

describe('OrderSelectionSchema', () => {
  it('accepts a choice', () => {
    expect(OrderSelectionSchema.safeParse({ kind: 'choose', choice: 1 }).success).toBe(true);
    expect(OrderSelectionSchema.safeParse({ kind: 'choose', choice: 3 }).success).toBe(true);
  });

  it('accepts unclear and back_out with a null choice', () => {
    expect(OrderSelectionSchema.safeParse({ kind: 'unclear', choice: null }).success).toBe(true);
    expect(OrderSelectionSchema.safeParse({ kind: 'back_out', choice: null }).success).toBe(true);
  });

  it('rejects choice 0 - options are 1-based', () => {
    expect(OrderSelectionSchema.safeParse({ kind: 'choose', choice: 0 }).success).toBe(false);
  });

  it('rejects a negative choice', () => {
    expect(OrderSelectionSchema.safeParse({ kind: 'choose', choice: -1 }).success).toBe(false);
  });

  it('rejects a non-integer choice like 1.5', () => {
    expect(OrderSelectionSchema.safeParse({ kind: 'choose', choice: 1.5 }).success).toBe(false);
  });

  it('rejects a choice sent as a string', () => {
    expect(OrderSelectionSchema.safeParse({ kind: 'choose', choice: '2' }).success).toBe(false);
  });

  it('rejects a bad kind', () => {
    expect(OrderSelectionSchema.safeParse({ kind: 'cancel', choice: 1 }).success).toBe(false);
  });
});

describe('ConfirmationReplySchema', () => {
  it('accepts yes and no', () => {
    expect(ConfirmationReplySchema.safeParse({ reply: 'yes' }).success).toBe(true);
    expect(ConfirmationReplySchema.safeParse({ reply: 'no' }).success).toBe(true);
  });

  it('rejects a third value - confirmation is binary', () => {
    expect(ConfirmationReplySchema.safeParse({ reply: 'other' }).success).toBe(false);
    expect(ConfirmationReplySchema.safeParse({ reply: 'maybe' }).success).toBe(false);
  });

  it('rejects anything else', () => {
    expect(ConfirmationReplySchema.safeParse({ reply: 'YES' }).success).toBe(false);
    expect(ConfirmationReplySchema.safeParse({ reply: true }).success).toBe(false);
    expect(ConfirmationReplySchema.safeParse({}).success).toBe(false);
  });
});

describe('PolicyAnswerSchema', () => {
  const valid = {
    answer: 'You can return an item within 30 days.',
    usedSources: ['returns.md'],
    confident: true,
  };

  it('accepts a grounded answer', () => {
    expect(PolicyAnswerSchema.safeParse(valid).success).toBe(true);
  });

  it('accepts an empty usedSources - gate G8 decides what that means', () => {
    expect(
      PolicyAnswerSchema.safeParse({ ...valid, usedSources: [], confident: false }).success,
    ).toBe(true);
  });

  it('rejects wrong types', () => {
    expect(PolicyAnswerSchema.safeParse({ ...valid, confident: 'yes' }).success).toBe(false);
    expect(PolicyAnswerSchema.safeParse({ ...valid, usedSources: 'returns.md' }).success).toBe(
      false,
    );
    expect(PolicyAnswerSchema.safeParse({ ...valid, usedSources: [1, 2] }).success).toBe(false);
  });

  it('rejects a missing field', () => {
    expect(PolicyAnswerSchema.safeParse(omit(valid, 'confident')).success).toBe(false);
  });
});
