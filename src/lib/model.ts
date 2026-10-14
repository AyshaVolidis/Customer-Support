// Picks and configures the model provider instance from env (LLM_MODEL).
// This is the ONLY file that knows which provider we use. Nowhere else names
// a model or imports a provider package.

import { groq } from '@ai-sdk/groq';
import type { LanguageModel } from 'ai';

/**
 * Read one required environment variable.
 * The error names the variable but never prints its value.
 */
function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing required environment variable ${name}. ` +
        `Copy .env.example to .env.local and fill it in.`,
    );
  }
  return value;
}

/**
 * The language model to use, named by LLM_MODEL.
 *
 * Provider: Groq. Model ids the installed @ai-sdk/groq knows about include
 * llama-3.3-70b-versatile, llama-3.1-8b-instant, openai/gpt-oss-120b,
 * openai/gpt-oss-20b, moonshotai/kimi-k2-instruct-0905 and
 * meta-llama/llama-4-scout-17b-16e-instruct; any other string is passed
 * through to the API unchanged.
 *
 * The provider reads GROQ_API_KEY from the environment itself, so we check it
 * here only to fail with a clear message instead of a 401 later.
 */
export function getModel(): LanguageModel {
  requireEnv('GROQ_API_KEY');
  const modelName = requireEnv('LLM_MODEL');

  return groq(modelName);
}
