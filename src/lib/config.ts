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

/**
 * Longest policy chunk we keep, in characters.
 *
 * A chunk has to be small enough that several fit in one prompt, and big enough
 * to answer a question on its own. A '##' section longer than this is split
 * further by RecursiveCharacterTextSplitter.
 */
export const CHUNK_SIZE = 800;

/**
 * Characters repeated between two pieces of a split section.
 *
 * The overlap keeps a sentence that straddles a cut readable in both pieces,
 * so retrieval does not lose the fact that happened to fall on the boundary.
 */
export const CHUNK_OVERLAP = 80;

/**
 * Lowest similarity score a retrieved chunk may have and still be used.
 *
 * Retrieval always returns its nearest neighbours, even for a question the
 * policies do not cover, so a floor is what turns "the closest chunks" into
 * "the relevant chunks". Below it a chunk is dropped, and a question with no
 * relevant chunk retrieves nothing — which gate G8 then turns into an honest
 * "I'm not sure" rather than an answer invented from unrelated text.
 *
 * This is a PLACEHOLDER value, to be calibrated against the evals.
 */
export const MIN_SCORE = 0.5;

/**
 * How many policy chunks a retrieval returns by default.
 *
 * Three is the design's "top 3": enough that the answer is not hostage to one
 * chunk being slightly closer, few enough to keep the answering prompt short.
 */
export const RETRIEVE_K = 3;
