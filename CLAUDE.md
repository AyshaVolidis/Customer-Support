# CLAUDE.md

Project rules for the customer-support assistant. Read this before writing code.

This is a **learning project**. Keep things simple and explicit. Do not
over-engineer, and do not build ahead of the step you were asked to do.

---

## Stack

| Layer | Choice |
| --- | --- |
| Framework | Next.js (App Router) + TypeScript |
| LLM calls | Vercel AI SDK Core (`ai`) |
| Validation | Zod |
| Database | Supabase (Postgres) |
| Unit / integration tests | Vitest |
| End-to-end tests | Playwright |
| Evals | Promptfoo |

Playwright and Promptfoo are part of the intended stack but are **not installed
yet** — add them in the step that needs them, not before.

---

## Architecture

### This is a workflow, not an autonomous agent

The design is **routing + prompt chaining + gates**. It is deliberately not an
autonomous agent, and should not drift into one.

Split the responsibilities like this:

- **The LLM understands, chooses and phrases.** It reads intent, picks between
  options it was offered, and writes the words the customer sees.
- **The CODE verifies, decides and executes.** Every check, every branch that
  matters, and every side effect.

Rules that follow from that:

- **Sensitive rules live in code, never only in prompts.** Permissions,
  ownership checks, and confirmation steps are code paths. A prompt instruction
  is not a control — treat it as a hint that can be ignored or talked around.
- **The LLM can never trigger a database write by itself.** A write happens
  because code decided to call a repository method, after its own checks passed.

### The server keeps no chat history

There is **no conversation history on the server**. The only memory is the
workflow state in `session_state` — where the customer is in a flow.

- Every message is understood **on its own, plus that state**. Nothing else.
- The UI still shows the customer the whole conversation. That transcript is a
  display concern; it is not the model's context and is not kept server-side as
  history.
- So `session_state` must carry everything the next turn needs. If a turn needs
  context that isn't in it, the fix is to put that in the state — not to start
  retaining history.

### Layering

All business logic lives in `src/lib/` as plain TypeScript with **no Next.js
imports**. It must be runnable from a plain `tsx` script and from a test, with
no request context.

`src/app/api/chat/route.ts` and the UI are **thin wrappers**: parse, call into
`src/lib/`, serialize the result. No business logic, no branching on domain
rules.

### Key modules

- **`src/lib/llm.ts`** — every LLM call lives here, in small exported functions
  with explicit input and output types, so tests can mock them. No LLM call
  anywhere else in the codebase.
- **`src/lib/agent.ts`** — `handleMessage` is the entry point. It accepts
  **injected dependencies** (repositories and llm functions) with real
  defaults, so a test can pass in-memory repositories and fake llm functions
  while production code calls it with no arguments.
- **`src/lib/model.ts`** — the model and provider are chosen in **exactly one
  place**. Model name comes from `LLM_MODEL`. Nowhere else names a model.
- **`src/lib/repositories/types.ts`** — all data access goes through these
  interfaces. Two implementations: `supabase.ts` (real) and `memory.ts`
  (tests). Nothing outside the repositories imports the Supabase client.
- **`src/lib/config.ts`** — constants: max message length, retries, demo
  customer id. **No magic numbers anywhere else.** (This file does not exist
  yet; create it when the first constant is needed.)
- **`src/lib/gates.ts`** — the checks an answer must pass before it reaches the
  customer.
- **`src/lib/schema.ts`** — Zod schemas for inputs and LLM outputs.
- **`src/lib/logger.ts`** — structured logging.

---

## Code rules

- **Order IDs are never shown to the LLM during order selection.** Give the LLM
  numbered labels, have it return a number, and map that number back to the real
  id **in code**. This keeps the model from inventing or leaking an id.
- **Use Zod to make mistakes hard to make.** Prefer `z.enum` over a free string,
  add regex constraints where a format is known, and validate LLM output on the
  way in — not just user input.
- **No magic numbers.** They belong in `src/lib/config.ts`.
- **Explicit types on exported functions.** Especially in `llm.ts`, where the
  types are the contract a mock has to satisfy.
- **The assistant replies in the customer's language** — Arabic or English,
  matching what the customer wrote.

---

## Security

- **Secrets are server-side only.** Never give a secret the `NEXT_PUBLIC_`
  prefix; that prefix ships the value to the browser.
- **Never import `src/lib/*` from a client component**, except `import type`.
  A type-only import erases at compile time; a value import would pull server
  code and its secrets into the client bundle.
- **Log every prompt sent to the model and every response**, via
  `src/lib/logger.ts`. This is how the workflow stays debuggable.
- **Never log secrets.** No API keys, no service-role keys, no tokens — not in
  logs, not in error messages, not in committed files.
- Secrets live in `.env.local`, which is gitignored. `.env.example` holds the
  variable names with empty values and is committed.

Environment variables: `GOOGLE_GENERATIVE_AI_API_KEY`, `LLM_MODEL`,
`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`.

---

## AI SDK notes

**The Vercel AI SDK's API differs significantly between major versions.** This
is the most common source of broken code here.

Before writing any AI SDK call:

1. Check the installed version: `npm ls ai`
2. Use the API that matches **that** version — verify against the package's own
   TypeScript types in `node_modules/ai`, or the official docs at
   [ai-sdk.dev](https://ai-sdk.dev).
3. **Never guess function names or option names.** If you cannot confirm a
   symbol exists, look it up rather than writing it from memory.

Currently installed (verified via `npm ls` on 2026-10-11):

- `ai@7.0.137`
- `@ai-sdk/google@4.0.93`
- `zod@4.6.5`
- `@supabase/supabase-js@2.117.3`
- `vitest@5.0.3`

Do **not** use:

- **AI SDK UI** (`useChat` and friends) — the UI stays a thin wrapper we control.
- **AI SDK RSC** — streaming React components from the server is out of scope.

---

## Working rules

- **Work only on the step you were asked to do.** Do not implement later steps,
  even when the next move looks obvious.
- **If something is ambiguous, ask before guessing.**
- **Write unit tests with Vitest** using the in-memory repositories and mocked
  LLM functions. **No network calls in tests.**
- **Verify before claiming.** "Tests pass" means the output was read. "Build
  works" means it was run.
- **After finishing any task, reply with a bullet-point summary** covering:
  - what you did
  - files created or changed, one line each
  - key decisions and assumptions
  - the exact commands to verify
  - anything not done, or risky

### Commands

```bash
npm run dev     # local dev server
npm run build   # production build
npm run lint    # eslint
npm run test    # vitest run
npm run try     # scratch script: tsx --env-file=.env.local src/scripts/try.ts
```

### Git

Keep git **local**. Do not add a remote, commit, or push unless explicitly
asked in that turn.
