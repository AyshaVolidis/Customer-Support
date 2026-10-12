// Zod schemas for agent input/output and shared data shapes.
// These constrain what the model is allowed to return, so a bad answer fails
// fast (gate G7) instead of flowing into the workflow.
//
// Format rules that are GATES live in code, not here - see gates.ts. This file
// only checks shape and type.

import { z } from 'zod';

/** The five intents. classifyIntent returns exactly one. */
export const IntentSchema = z
  .enum([
    'policy_question',
    'order_lookup',
    'cancel_order',
    'human_handoff',
    'out_of_scope',
  ])
  .describe('The single intent that best matches the customer message');

export type Intent = z.infer<typeof IntentSchema>;

/** One selectable option shown to the customer during order selection. */
export const ChatOptionSchema = z.object({
  id: z
    .string()
    .describe('The temporary option number as a string, e.g. "2" - never a real order id'),
  label: z.string().describe('Human-readable label, e.g. "Wireless headphones (ordered Oct 5)"'),
});

export type ChatOption = z.infer<typeof ChatOptionSchema>;

/** The final response returned for every message. Validated by gate G7. */
export const ChatResponseSchema = z.object({
  answer: z.string().describe("The reply text, in the customer's language"),
  intent: IntentSchema,
  needsConfirmation: z
    .boolean()
    .describe('True when the reply asks the customer to confirm a cancellation'),
  options: z
    .array(ChatOptionSchema)
    .describe('Selectable options, e.g. the cancellable orders. Empty when there is nothing to pick'),
  offerHandoff: z
    .boolean()
    .describe('True when the reply offers to hand the customer to a human'),
  sources: z
    .array(z.string())
    .describe('Policy file names the answer came from. Empty for non-policy replies'),
});

export type ChatResponse = z.infer<typeof ChatResponseSchema>;

/** What classifyIntent returns for a message received while idle. */
export const IntentClassificationSchema = z.object({
  intent: IntentSchema,
  orderId: z
    .string()
    .max(20)
    .nullable()
    .describe(
      'The order id mentioned in the message, exactly as written, or null if none. ' +
        'Do not invent or correct it - the code validates the format (gate G1)',
    ),
  wantsHuman: z.boolean().describe('True if the customer asks to talk to a person'),
  isComplaint: z
    .boolean()
    .describe('True if the customer reports a damaged, broken, wrong or missing item'),
});

export type IntentClassification = z.infer<typeof IntentClassificationSchema>;

/** What classifyPendingReply returns while a step is awaiting an answer. */
export const PendingReplyClassificationSchema = z.object({
  kind: z
    .enum(['answer_to_pending', 'new_topic'])
    .describe(
      'answer_to_pending if the message replies to our last question, ' +
        'new_topic if the customer has moved on to something else',
    ),
});

export type PendingReplyClassification = z.infer<typeof PendingReplyClassificationSchema>;

/** How the model reads a reply to "which order did you mean?". */
export const OrderSelectionSchema = z.object({
  kind: z
    .enum(['choose', 'unclear', 'back_out'])
    .describe(
      'choose if the customer picked one of the numbered options, ' +
        'unclear if you cannot tell which, back_out if they no longer want to cancel',
    ),
  choice: z
    .number()
    .int()
    .min(1)
    .nullable()
    .describe('The option NUMBER the customer picked (1-based), or null unless kind is choose'),
});

export type OrderSelection = z.infer<typeof OrderSelectionSchema>;

/** How the model reads a reply to "cancel order X?". */
export const ConfirmationReplySchema = z.object({
  reply: z
    .enum(['yes', 'no', 'other'])
    .describe(
      'yes only for an explicit confirmation, no for a refusal, ' +
        'other for anything ambiguous or unrelated',
    ),
});

export type ConfirmationReply = z.infer<typeof ConfirmationReplySchema>;

/** The grounded answer to a policy question. Checked by gate G8. */
export const PolicyAnswerSchema = z.object({
  answer: z
    .string()
    .describe("The answer, built ONLY from the provided sources, in the customer's language"),
  usedSources: z
    .array(z.string())
    .describe('File names of the provided sources you actually used. Empty if none applied'),
  confident: z
    .boolean()
    .describe('False if the sources do not really answer the question'),
});

export type PolicyAnswer = z.infer<typeof PolicyAnswerSchema>;
