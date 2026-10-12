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
