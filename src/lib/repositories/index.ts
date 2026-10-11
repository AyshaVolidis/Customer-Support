// The one place that decides which repository implementations the app uses.
// Everything else depends on the interfaces in types.ts, not on these classes.

import {
  SupabaseHandoffRepository,
  SupabaseOrderRepository,
  SupabaseSessionStore,
} from './supabase';
import type { Repositories } from './types';

// Types and interfaces, re-exported so callers need only import from here.
export * from './types';

/**
 * The repositories the app runs with: the Supabase implementations.
 *
 * Each one shares the single lazily-created Supabase client, so nothing
 * connects and no env var is read until this is actually called.
 */
export function getRepositories(): Repositories {
  return {
    orders: new SupabaseOrderRepository(),
    sessions: new SupabaseSessionStore(),
    handoffs: new SupabaseHandoffRepository(),
  };
}
