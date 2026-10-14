# Customer Support Assistant

A customer-support assistant for a small online shop. It answers policy
questions, looks up orders, cancels orders after explicit confirmation, hands
off to a human, and politely refuses anything out of scope.

This is a **learning project**, built step by step to practise the full cycle of
build → evaluate → test. The code is deliberately simple and explicit.

> **Status: partly built.** Order lookup works end to end. The other three
> flows answer "not implemented yet". See [Current status](#current-status).

---

## How it works

This is a **workflow**, not an autonomous agent:

- **The LLM** understands, chooses between options it was offered, and phrases
  the reply.
- **The CODE** verifies, decides, and executes. Every check and every database
  write is a code path.

Sensitive rules — who owns an order, whether it can be cancelled, whether the
customer confirmed — live in code, never only in a prompt. **The LLM can never
trigger a database write by itself.**

The server keeps **no chat history**. The only memory is the workflow state in
`session_state` (where the customer is in a flow). The browser shows the whole
conversation, but the model never sees it.

Full design: [`docs/design.md`](docs/design.md).
A step-by-step walkthrough of one flow: [`docs/order-lookup-walkthrough.md`](docs/order-lookup-walkthrough.md).

---

## Stack

| Layer | Choice |
| --- | --- |
| Framework | Next.js 16 (App Router) + TypeScript |
| LLM calls | Vercel AI SDK Core (`ai` v7) |
| Provider | Groq (`@ai-sdk/groq`) |
| Validation | Zod v4 |
| Database | Supabase (Postgres) |
| Unit tests | Vitest |

Planned but **not installed yet**: Playwright (e2e), Promptfoo (evals).

---

## Setup

### 1. Install

```bash
npm install
```

### 2. Environment

```bash
cp .env.example .env.local
```

Fill in `.env.local`:

| Variable | Where to get it |
| --- | --- |
| `GROQ_API_KEY` | [console.groq.com](https://console.groq.com) → API Keys (free tier) |
| `LLM_MODEL` | e.g. `llama-3.3-70b-versatile`, or `llama-3.1-8b-instant` for speed |
| `SUPABASE_URL` | Supabase dashboard → Project Settings → API |
| `SUPABASE_SERVICE_ROLE_KEY` | same page — **server-side only, never commit** |

`.env.local` is gitignored. The service-role key bypasses row-level security, so
it must never reach the browser.

### 3. Database

In the Supabase dashboard → **SQL Editor**, run in this order:

1. [`supabase/schema.sql`](supabase/schema.sql) — creates `orders`,
   `session_state`, `handoff_tickets`, and enables RLS with **no policies** (so
   only the service-role key can read or write)
2. [`supabase/seed.sql`](supabase/seed.sql) — demo orders for `cust_001` and
   `cust_002`

Both files are safe to re-run. To reset the demo data:

```sql
delete from handoff_tickets;
delete from session_state;
delete from orders where customer_id in ('cust_001', 'cust_002');
-- then run seed.sql again
```

### 4. Run

```bash
npm run dev
```

Open <http://localhost:3000>.

---

## Commands

```bash
npm run dev     # dev server
npm run build   # production build
npm run start   # serve the production build
npm run lint    # eslint
npm run test    # vitest run (166 tests)
npm run try     # scratch CLI, see below
```

### The scratch CLI

`npm run try` exercises one piece at a time without the browser:

```bash
npm run try -- db                                    # read-only DB smoke test
npm run try -- model "say hi in one short sentence"  # one LLM call
npm run try -- classify "where is my order 1002?"    # classifyIntent
npm run try -- classify "yes" offered                # ...with handoffOffered = true
npm run try -- reply "<message>" "<facts>"           # writeReply
npm run try -- chat s1 "where is my order 1002?"     # the whole flow
```

`db` and `chat` write a `try-<timestamp>` row to `session_state`. Clear them
with `delete from session_state where session_id like 'try-%';`.

---

## Project layout

```
src/
  app/
    page.tsx            server component, renders the chat
    ChatClient.tsx      the chat UI (client); no runtime import from src/lib
    globals.css         design tokens + all styles (plain CSS)
    api/chat/route.ts   POST /api/chat - thin wrapper
  lib/                  all business logic, plain TypeScript, no Next.js imports
    agent.ts            handleMessage: the workflow entry point
    llm.ts              every LLM call lives here (classifyIntent, writeReply)
    model.ts            the one place that picks the provider and model
    schema.ts           Zod schemas for inputs and LLM output
    gates.ts            G1-G9, the checks the code performs
    tools.ts            lookupOrder
    cancelHelpers.ts    pure helpers for order selection
    logger.ts           prompt/response logging, with secret redaction
    config.ts           constants (no magic numbers elsewhere)
    chatRequest.ts      request-body shape check
    rag.ts              placeholder - policy retrieval not built yet
    repositories/       data access behind interfaces
      types.ts          the interfaces every caller depends on
      supabase.ts       real implementation
      memory.ts         in-memory implementation, used by tests
      index.ts          getRepositories()
  scripts/try.ts        the scratch CLI
data/policies/          policy markdown for RAG (empty)
docs/                   design doc and walkthrough
supabase/               schema.sql, seed.sql
tests/unit/             Vitest unit tests
tests/api, tests/e2e    empty
evals/                  empty
```

---

## How one message travels

```
browser -> POST /api/chat
        -> parseChatRequest        shape check
        -> handleMessage
             G9   is the request usable?
             DB   read session_state
             LLM  classifyIntent -> intent + orderId
             CODE route to the flow (gates, repositories)
             LLM  writeReply -> phrase the answer from facts
             G7   validate the response against the Zod schema
        -> JSON response
```

The LLM is given **facts**, never raw database rows, and never a real order id
during order selection — it sees numbered labels and returns a number, which the
code maps back to the real id.

---

## The gates

Checked in code, not by the LLM:

| Gate | Check |
| --- | --- |
| G1 | Order id is exactly 4 digits |
| G2 | Order exists |
| G3 | Order belongs to this customer — answered **identically** to G2 |
| G4 | Order status is `processing` (cancellable) |
| G5 | Chosen option number is within 1..N |
| G6 | The customer explicitly confirmed |
| G7 | Model output matches the Zod schema (retry once, then fail) |
| G8 | A policy answer needs a retrieved source and `confident = true` |
| G9 | Message non-empty, within `MAX_MESSAGE_LENGTH`, `sessionId` present |

G2 and G3 return the same message on purpose: if "does not exist" and "not
yours" sounded different, a customer could probe for real order numbers.

---

## Current status

| Part | State |
| --- | --- |
| Repositories (Supabase + in-memory) | done, tested |
| Zod schemas, gates, logger | done, tested |
| `classifyIntent`, `writeReply` | done |
| **`order_lookup` flow** | **done, tested** |
| `cancel_order` flow | helpers written and tested; flow not wired up |
| `policy_question` flow | not started (`rag.ts` is a placeholder) |
| `human_handoff` flow | not started |
| `POST /api/chat` | done |
| Chat UI | done (text only) |
| Session state writes | not yet — state is read and logged, never written |
| e2e tests, evals | not started |

The three unimplemented intents return a valid response whose `answer` says
"not implemented yet".

### Known limitations

- **Auth is a fixed demo customer** (`cust_001` in `config.ts`). `sessionId`
  comes from the client, so anyone can read another session's state by guessing
  its id. No auth, no rate limiting.
- **No chat history**, by design. A follow-up like "and if it's broken?" is not
  understood — the customer has to write the full question.
- **Two LLM calls per message** (classify, then phrase), run in sequence, with
  no timeout. A slow or rate-limited provider makes the UI wait.
- **No streaming**: the reply appears all at once.
- **The UI ignores `options`, `needsConfirmation`, `offerHandoff` and
  `sources`** — it shows `answer` only.
- **No product catalog**, so prices and recommendations are out of scope and
  are never invented.

---

## Conventions

House rules live in [`CLAUDE.md`](CLAUDE.md). The short version:

- All business logic in `src/lib/`, plain TypeScript, no Next.js imports. The
  route and the UI are thin wrappers.
- Every LLM call in `src/lib/llm.ts`, with explicit types, so tests can mock it.
- `handleMessage` takes injected dependencies with real defaults — tests pass
  in-memory repositories and fake LLM functions, so **no test touches the
  network**.
- The provider and model are chosen in `src/lib/model.ts` and nowhere else.
- All data access goes through the interfaces in `repositories/types.ts`.
- Constants live in `src/lib/config.ts`.
- Secrets are server-side only. Never use the `NEXT_PUBLIC_` prefix for a
  secret, and never import `src/lib/*` from a client component except
  `import type`.
- The AI SDK's API changes between major versions: check `npm ls ai` and verify
  against the installed types or [ai-sdk.dev](https://ai-sdk.dev) rather than
  guessing.
