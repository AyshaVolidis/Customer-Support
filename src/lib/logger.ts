// Simple structured logging for agent runs (no secrets in log output).
// Every prompt sent to the model and every response comes through here, so
// redaction is the whole point: a leaked key in a log is still a leaked key.

/** Longest text we print per field before truncating. */
export const MAX_LOGGED_LENGTH = 2000;

/**
 * Patterns that look like credentials, with what to replace them by.
 * Deliberately eager: over-redacting a log line is cheap, leaking is not.
 */
// NOTE: these prefix patterns deliberately have NO leading \b. A word boundary
// fails when a key is glued to preceding text (e.g. "...zzzAIzaSy..."), which
// would leave the secret unredacted - and a later truncation could then print a
// fragment of it.
const SECRET_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  // JWTs - a Supabase service-role key is one: three base64url segments.
  [/eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g, '[REDACTED_JWT]'],

  // Google AI Studio / Gemini keys.
  [/AIza[A-Za-z0-9_-]{10,}/g, '[REDACTED_KEY]'],

  // OpenAI / Anthropic style.
  [/sk-[A-Za-z0-9_-]{10,}/g, '[REDACTED_KEY]'],

  // GitHub tokens.
  [/gh[pousr]_[A-Za-z0-9]{10,}/g, '[REDACTED_KEY]'],
  [/github_pat_[A-Za-z0-9_]{10,}/g, '[REDACTED_KEY]'],

  // Slack tokens.
  [/xox[baprs]-[A-Za-z0-9-]{10,}/g, '[REDACTED_KEY]'],

  // Authorization headers: keep the scheme, drop the value.
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{10,}/gi, '$1 [REDACTED]'],

  // Anything named like a credential: "api_key": "...", token=..., secret: ...
  [
    /\b((?:api[_-]?key|apikey|access[_-]?token|auth[_-]?token|token|secret|password|passwd|pwd|service[_-]?role[_-]?key)\b["']?\s*[:=]\s*["']?)([^"'\s,}]{4,})/gi,
    '$1[REDACTED]',
  ],
];

/** Replace anything that looks like a credential with a placeholder. */
export function redactSecrets(text: string): string {
  let result = text;
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

/** Shorten text past `max`, saying how much was dropped. */
export function truncate(text: string, max: number = MAX_LOGGED_LENGTH): string {
  if (text.length <= max) return text;
  const dropped = text.length - max;
  return `${text.slice(0, max)}... [truncated ${dropped} more chars]`;
}

/** Turn any value into printable text, without throwing on odd input. */
function toText(value: unknown): string {
  if (value === undefined) return '(none)';
  if (typeof value === 'string') return value;
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    // Circular references, BigInt, and similar.
    return String(value);
  }
}

/**
 * Redact first, then truncate.
 *
 * The order matters: truncating first could cut a secret in half and leave a
 * prefix that no longer matches any pattern - so it would be printed.
 */
function forLog(value: unknown): string {
  return truncate(redactSecrets(toText(value)));
}

export type LLMCallLog = {
  /** Which llm.ts function this was, e.g. 'classifyIntent'. */
  name: string;
  /** What was sent to the model: a prompt string or an options object. */
  input: unknown;
  /** What came back. Omit when the call failed. */
  output?: unknown;
  /** The failure, if the call threw. */
  error?: unknown;
  /** How long the call took, in milliseconds. */
  durationMs?: number;
};

/**
 * Print one block per LLM call: name, input, output or error, and duration.
 * One console call per block, so blocks never interleave.
 */
export function logLLMCall({ name, input, output, error, durationMs }: LLMCallLog): void {
  const timing = durationMs === undefined ? '' : ` (${durationMs} ms)`;
  const lines = [`=== LLM ${name}${timing} ===`, '--- input ---', forLog(input)];

  if (error !== undefined) {
    lines.push('--- ERROR ---', forLog(error));
  } else {
    lines.push('--- output ---', forLog(output));
  }

  lines.push(`=== end LLM ${name} ===`);

  const block = lines.join('\n');
  if (error !== undefined) {
    console.error(block);
  } else {
    console.log(block);
  }
}

/** One-line informational log. Redacted and truncated like everything else. */
export function logInfo(message: string, data?: unknown): void {
  const text = truncate(redactSecrets(message));
  if (data === undefined) {
    console.log(`[info] ${text}`);
    return;
  }
  console.log(`[info] ${text}\n${forLog(data)}`);
}
