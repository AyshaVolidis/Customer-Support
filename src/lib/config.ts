// Constants for the whole app. No magic numbers anywhere else.

/**
 * The customer the MVP acts as. Auth is a fixed demo customer for now; when
 * real auth arrives the customer id comes from auth instead of this constant.
 */
export const DEMO_CUSTOMER_ID = 'cust_001';

/**
 * How many times an LLM call is retried when its output fails the Zod schema
 * (gate G7). 1 means two attempts in total, then a clear error.
 */
export const LLM_SCHEMA_RETRIES = 1;

/** Longest customer message we accept (gate G9), in characters. */
export const MAX_MESSAGE_LENGTH = 500;

/**
 * Unclear replies allowed in one pending step before the flow gives up.
 *
 * `retries` is set to 0 on entering a step and incremented per unclear reply;
 * when it goes ABOVE this number the flow returns to idle. At 2 the customer
 * gets two re-asks and the third unclear reply ends the flow.
 */
export const MAX_RETRIES = 2;
