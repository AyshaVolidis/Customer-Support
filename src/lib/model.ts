// Picks and configures the model provider instance from env (LLM_MODEL).
// This is the ONLY file that knows which provider we use. Nowhere else names
// a model or imports a provider package.

import { google } from '@ai-sdk/google';
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
 * The provider reads GOOGLE_GENERATIVE_AI_API_KEY from the environment itself,
 * so we check it here only to fail with a clear message instead of a 401 later.
 */
export function getModel(): LanguageModel {
  requireEnv('GOOGLE_GENERATIVE_AI_API_KEY');
  const modelName = requireEnv('LLM_MODEL');

  return google(modelName);
}
