# Design — Customer-Support Assistant

Design document for the MVP. This describes intended behaviour only; no code
exists for it yet.

Architecture context lives in [`CLAUDE.md`](../CLAUDE.md): this is a
**workflow** (routing + prompt chaining + gates), not an autonomous agent. The
LLM understands, chooses and phrases; the code verifies, decides and executes.


---

## 1. Goal

A customer-support assistant that:

- answers policy questions (RAG over policy docs)
- looks up orders
- cancels orders after explicit confirmation
- hands off to a human agent (simulated)
- politely refuses out-of-scope requests
- **remembers where it is in a flow; no chat history is stored** (the only
  memory is the workflow state in `session_state`)

---

## 2. Intents

Five intents. `classifyIntent` returns exactly one.

| Intent | Covers | Notes |
| --- | --- | --- |
| `policy_question` | Returns, shipping, warranty | Answered via RAG (§8). Damaged / broken / wrong-item complaints are **also** `policy_question`, with `offerHandoff = true` |
| `order_lookup` | "where is my order 1002?" | See the order lookup flow (§10) |
| `cancel_order` | "cancel order 1005"; "cancel my order" (no number); "where is my order and I want to cancel it" | The last case is a cancel, not a lookup — **lookup is part of the cancel flow** (§6) |
| `human_handoff` | "I want to talk to a person" | See §7 |
| `out_of_scope` | Prices; product recommendations; unrelated requests (poems); requests for **other customers'** data; prompt-injection attempts | No catalog in the MVP — **never invent prices**. Reply politely and say what the assistant *can* help with (§9) |

---

## 3. Message flow (every message)

| # | Actor | Step |
| --- | --- | --- |
| 1 | **CODE** | Validate input (**G9**) |
| 2 | **DB** | Read session state. No row = `idle`. The server does **not** store or load chat history |
| 3 | **CODE** | Decide which question to ask the LLM, based on the **stored state** |
| 4 | **CODE** | Route to the flow |
| 5 | **DB** | Write the new state (upsert) |
| 6 | **CODE** | Validate the response with Zod (**G7**) and return it |

### Step 3 — which question the code asks

| Stored state | LLM call | Returns |
| --- | --- | --- |
| `idle` | `classifyIntent` — also receives `state.handoffOffered` as context, so a short "yes" after we offered a human is understood | One of the 5 intents, plus extracted `orderId` (or `null`), `wantsHuman`, `isComplaint` (customer reports a damaged / broken / wrong / missing item) |
| `awaiting_*` | `classifyPendingReply` | `answer_to_pending` (replying to our last question) or `new_topic` |

- `answer_to_pending` → continue the pending flow.
- `new_topic` → **reset everything to `idle`**, then run `classifyIntent`.

### Step 5 — flag lifetime

A flag such as `handoffOffered` stays `true` **only if THIS turn set it**. Any
other message clears it.

### Who owns the state

The state is stored in the database (`session_state`), keyed by `sessionId`.
**The LLM never decides or writes the state; the code does.**

### Diagram

```
                  message + sessionId
                          |
                          v
          [CODE] G9 validate input  --(fail)--> reject
                          |
                          v
          [DB] read session_state(sessionId)
                (no row => step = idle)
                          |
         +----------------+-----------------+
         |                                  |
   step = idle                      step = awaiting_*
         |                                  |
         v                                  v
 [LLM] classifyIntent            [LLM] classifyPendingReply
 (+ state.handoffOffered)                  |
         |                     +-----------+------------+
         |                     |                        |
         |              answer_to_pending           new_topic
         |                     |                        |
         |                     |              reset everything -> idle
         |                     |                        |
         |                     |                        v
         |                     |              [LLM] classifyIntent
         |                     |                        |
         +---------------------+------------------------+
                          |
                          v
                [CODE] route to the flow
                          |
                          v
        [DB] upsert session_state  (flags: true only
              if set this turn, else cleared)
                          |
                          v
       [CODE] G7 validate response (Zod) -> return
```

---

## 4. Session state

Stored in `session_state`, keyed by `sessionId`.

```ts
{
  step: 'idle' | 'awaiting_order_selection' | 'awaiting_confirmation',
  candidateOrders?: { n: number, id: string, label: string }[],
  selectedOrderId?: string,
  retries?: number,
  handoffOffered?: boolean,
  problemText?: string
}
```

| Field | Purpose |
| --- | --- |
| `step` | Where the customer is in a flow. Absent row = `idle` |
| `candidateOrders` | The numbered cancellable orders offered for selection: temporary number `n`, the **real id** (kept only in code/state), and a human `label` |
| `selectedOrderId` | The real order id awaiting confirmation |
| `retries` | Unclear replies in the **current** pending step. Set to `0` whenever a pending step is entered, so the limit is per step — see [Retry rule](#retry-rule) |
| `handoffOffered` | Set when a handoff was offered this turn; cleared by any other message |
| `problemText` | The customer's complaint text, stored when a handoff is offered, used later as the ticket `message` |

### Retry rule

- `retries` is set to **0 whenever a pending step is entered**. The limit is
  therefore **per step**, not per conversation.
- Each `unclear` reply in **order selection** increments `retries`.
  Confirmation does **not** use retries — it never re-asks (§6.4).
- If `retries > MAX_RETRIES` → go to `idle` with a polite message.
  Otherwise → ask again.
- With `MAX_RETRIES = 2`, the customer gets **two re-asks** and the **third**
  unclear reply goes to `idle`.
- `new_topic` resets everything to `idle`.

---

## 5. Memory model

- The server keeps **no chat history**. It does not store or load it.
- The only memory is the workflow state in `session_state`.
- Every message is understood on its own, plus that state.
- The UI still shows the whole conversation to the customer — a display concern,
  not model context.

"Remembers the conversation" in §1 means exactly this and nothing more: the
assistant remembers **where it is in a flow**.

---

## 6. Cancel flow

**Only orders with status `processing` are cancellable, and only those are ever
sent to the LLM.**

### 6.1 `idle` + `cancel_order` **with** an order id

1. Check **G1, G2, G3, G4**.
2. State → `awaiting_confirmation` with `selectedOrderId`.
3. Ask: *"Cancel order `<id>` (`<item name>`)?"* with `needsConfirmation = true`.

### 6.2 `idle` + `cancel_order` **without** an id

Get the customer's cancellable orders.

| Result | Behaviour |
| --- | --- |
| None | Say so. Stay `idle` |
| Some | Build `candidateOrders`, reply with `options` (**labels only**), state → `awaiting_order_selection`, `retries = 0` |

Each candidate gets:

- a temporary number `n` (1..N)
- the real id — **kept only in code/state**
- a human label: item name + order date, e.g. `"Wireless headphones (ordered Oct 5)"`
- **if two labels collide, append `" - 1 of 2"` / `" - 2 of 2"`** to them. The
  order date is already part of the label.

The reply carries `options` with **labels only**: each entry's `id` is the
temporary number `n` as a string (e.g. `"2"`), **never the real order id**.

Real order ids appear in reply text only **after** the customer has selected an
order — they are then the customer's own order numbers.

### 6.3 `awaiting_order_selection`

The LLM sees **ONLY the numbered labels — never order ids** — and returns:

```ts
{ kind: 'choose' | 'unclear' | 'back_out', choice: number | null }
```

| `kind` | Code does |
| --- | --- |
| `choose` | Apply **G5** (choice is a number in 1..N) → map to the real id → **re-check G1–G4** on that order → state `awaiting_confirmation`, `retries = 0` |
| `unclear` | Increment `retries`. If `retries > MAX_RETRIES` → polite message, `idle`. Otherwise ask again |
| `back_out` | `idle` |

### 6.4 `awaiting_confirmation`

The LLM interprets the reply as `yes` | `no`. **There is no third value.**

| Reply | Code does |
| --- | --- |
| `yes` | **G6** → re-check **G1–G4** → **the CODE calls `cancelOrder`** → success reply → `idle` |
| `no` | "nothing was cancelled, ask again if you still want to" → `idle` |

**Confirmation is binary, and an unclear reply counts as `no`.** Cancelling is
destructive and cannot be undone, so the model is told to answer `yes` only for
a clear, unambiguous agreement and `no` whenever it is unsure. "maybe", "I
don't know", a question about the order, or anything it cannot read are all
`no`.

This step therefore **never re-asks and never uses `retries`**. Ending the flow
costs the customer one message to start again; guessing `yes` costs them an
order.

### 6.5 Safety

- The LLM **never** triggers a cancellation.
- "Cancel all my orders" never cancels directly — at most one order, and only
  after confirmation.
- Prompt injection cannot change what the code allows.

### 6.6 State machine

```
                         cancel_order
                               |
            +------------------+------------------+
            |                                     |
      with order id                        without order id
            |                                     |
      G1,G2,G3,G4                    fetch cancellable orders
            |                            (status = processing)
            |                                     |
            |                       +-------------+-------------+
            |                       |                           |
            |                  none found                  some found
            |                       |                           |
            |              "no cancellable orders"    build candidateOrders
            |                       |                 (n, real id, label)
            |                       v                           |
            |                     idle                          v
            |                                    +------------------------+
            |                                    | awaiting_order_        |
            |                                    | selection              |
            |                                    | (entered: retries = 0) |
            |                                    +------------------------+
            |                                      |        |         |
            |                     choose (G5) -----+        |         +-- back_out
            |                     map n -> real id          |              |
            |                     re-check G1-G4         unclear           v
            |                               |          retries += 1      idle
            |                               |               |
            |                               |     +---------+---------+
            |                               |     |                   |
            |                               |  retries >          retries <=
            |                               |  MAX_RETRIES        MAX_RETRIES
            |                               |     |                   |
            |                               |     v                   v
            |                               |  polite msg         ask again
            |                               |  -> idle
            v                               v
       +-------------------------------------------------+
       |              awaiting_confirmation              |
       |        (binary: no retries, never re-asks)      |
       +-------------------------------------------------+
            |                            |
           yes                          no
      (clear agreement)        (refusal OR anything
            |                   unclear - fail-safe)
    G6 + re-check G1-G4                  |
            |                            v
            v                    "nothing was cancelled,
   [CODE] cancelOrder             ask again if you still
            |                      want to"
     +------+------+                     |
     |             |                     v
  ok: true    ok: false                idle
     |             |
     v             v
 success      "it did not go
  reply        through" (never
     |         claims success)
     |             |
     +------+------+
            v
          idle
```

`MAX_RETRIES = 2` applies to **order selection only**: two re-asks, then the
third unclear reply goes `idle`. Confirmation has no retries.

---

## 7. Handoff flow

Simulated. **No questions.**

### Entry

- Intent `human_handoff` (the customer asks for a person), **or**
- the customer accepts a previously offered handoff — `state.handoffOffered = true`,
  which `classifyIntent` receives as context.

### Behaviour

1. The code creates **ONE** row in `handoff_tickets`.
2. Its `message` is the customer's problem text:
   - `state.problemText` if a handoff had been offered (the complaint stored earlier),
   - otherwise the current message.
3. Reply, **phrased by the LLM from facts**: *OK, your issue has been recorded
   and the team will get back to you within the day.*
   - No questions, no solving attempt, no extra states.
4. State → `idle`; `handoffOffered` and `problemText` are cleared.

### Rule

**Never trap the customer:** a handoff request always ends in a ticket.

```
  human_handoff          accepts offered handoff
  (asks for a person)    (state.handoffOffered = true)
          |                        |
          +-----------+------------+
                      |
                      v
       [CODE] insert ONE handoff_tickets row
       message = state.problemText if offered,
                 else the current message
                      |
                      v
       [LLM] phrase the reply from facts
       "recorded, team will reply within the day"
                      |
                      v
       idle  (handoffOffered + problemText cleared)
```

---

## 8. Policy flow

```
  customer question
          |
          v
  [LLM] rewrite as a short ENGLISH search query
          |
          v
  [RAG] retrieve top 3 chunks
          |
          v
  [LLM] answer ONLY from those chunks,
        in the customer's language
        -> { answer, usedSources, confident }
          |
          v
  [CODE] G8: sources present AND confident?
          |
    +-----+------------------+
    |                        |
   yes                      no
    |                        |
  answer            "not sure" + offerHandoff = true
    |                        |
    +-----------+------------+
                |
                v
   if classification isComplaint:
   offerHandoff = true (always)
                |
                v
   if offerHandoff:
     state.handoffOffered = true
     state.problemText = customer's message
```

- The LLM rewrites the question as a short **English** search query.
- Retrieve **top 3** chunks (RAG).
- The LLM answers **ONLY from them**, in the customer's language, returning
  `{ answer, usedSources, confident }`.
- **G8**: if no sources **or** not confident → say you're not sure and set
  `offerHandoff = true`.
- If the classification says `isComplaint`, **always** set `offerHandoff = true`.
- When `offerHandoff` is true, store `state.handoffOffered = true` and
  `state.problemText` = the customer's message.
- The response's `sources` is `usedSources`, **filtered to file names that were
  actually in the retrieved chunks**.

---

## 9. Out-of-scope flow

- Polite refusal that **lists what the assistant can do**:
  - order status
  - cancelling orders
  - return / shipping / warranty policies
  - talking to a human
- **Never invent prices or product info.**
- **No tool calls and no database writes** in this route.

---

## 10. Order lookup flow

`classifyIntent` extracts `orderId` or `null`. **No state change, no database
writes** — the state stays `idle` in both branches.

### 10.1 No `orderId`

- Return the customer's **most recent** order via a new repository method
  `getLatestOrder(customerId)`: highest `created_at`, **any status, even if
  cancelled**.
- The reply **says it is their most recent order** and invites them to give a
  number for another one.
- If the customer has **no orders**, say so.
- **No G1–G3 needed** — the query is already filtered by customer.

### 10.2 With `orderId`

- Check **G1**, **G2**, **G3**.
- **G2 and G3 failures return the exact same reply** (a missing order and
  someone else's order are indistinguishable to the customer).
- On success the LLM phrases a short reply **from facts**: order id, item name,
  status, order date.

Note there is no **G4** here: a lookup works for any status, not only
`processing`.

### 10.3 Diagram

```
                       order_lookup
                            |
                            v
          orderId extracted by classifyIntent?
                            |
          +-----------------+------------------+
          |                                    |
         no                                   yes
          |                                    |
          v                                    v
  [DB] getLatestOrder(customerId)        G1  4 digits
       highest created_at,                    |
       ANY status (even cancelled)       G2  exists
          |                                   |
    +-----+-----+                        G3  belongs to customer
    |           |                             |
 no orders   an order                  G2/G3 fail -> IDENTICAL reply
    |           |                             |
    v           v                        on success
 "you have   [LLM] phrase reply:              |
  no orders"  this is your MOST               v
    |         RECENT order + invite    [LLM] phrase short reply
    |         a number for another     from facts: order id,
    |           |                      item name, status, order date
    |           |                             |
    +-----+-----+-----------------------------+
          |
          v
   state stays idle
   (no state change, no database writes)
```

---

## 11. Gates

Checked **in code, not by the LLM**.

| Gate | Check |
| --- | --- |
| **G1** | Order id is exactly **4 digits** |
| **G2** | Order **exists** |
| **G3** | Order **belongs to this customer** — if not, respond **exactly** as if it does not exist |
| **G4** | Order status is `processing` (cancellable) |
| **G5** | Chosen number is in **1..N** of `candidateOrders` |
| **G6** | The customer **explicitly confirmed** — only `yes` passes. The reply is binary, so an unclear answer arrives as `no` and is refused here (§6.4) |
| **G7** | Model output matches the Zod schema — **retry once**, then a safe error reply |
| **G8** | Policy answers need **at least one retrieved source** and `confident = true` |
| **G9** | Message non-empty, `<= MAX_MESSAGE_LENGTH`, `sessionId` present |

Where each gate is applied:

| Gate | Applied in |
| --- | --- |
| G9 | Every message, step 1 |
| G1–G4 | Cancel with an id (§6.1); after selection (§6.3); again on `yes` (§6.4) |
| G1–G3 | Order lookup **with** an `orderId` (§10.2) — no G4, and none of them on the no-id path (§10.1) |
| G5 | `awaiting_order_selection` (§6.3) |
| G6 | `awaiting_confirmation` (§6.4) |
| G7 | Every message, step 6 |
| G8 | Policy flow (§8) |

---

## 12. Response schema (Zod)

```ts
{
  answer: string,
  intent: 'policy_question' | 'order_lookup' | 'cancel_order'
        | 'human_handoff' | 'out_of_scope',
  needsConfirmation: boolean,
  options: { id: string, label: string }[],
  offerHandoff: boolean,
  sources: string[]
}
```

| Field | Set by |
| --- | --- |
| `answer` | The flow's reply text, phrased by the LLM |
| `intent` | `classifyIntent` |
| `needsConfirmation` | `true` when asking to confirm a cancellation (§6.1) |
| `options` | The candidate labels during order selection (§6.2). `id` is the temporary number `n` **as a string** (e.g. `"2"`) — never the real order id |
| `offerHandoff` | Policy flow (§8) |
| `sources` | `usedSources` from the policy answer, filtered to file names that were actually in the retrieved chunks (§8) |

---

## 13. Data (Supabase)

| Table | Holds |
| --- | --- |
| `orders` | Customer orders, incl. status (`processing` = cancellable) and `created_at` |
| `session_state` | Workflow state, keyed by `sessionId`, with `customer_id` as a column of the row |
| `handoff_tickets` | One row per handoff, with `message` |

- Demo customer id: **`cust_001`** (fixed in the MVP).
- `session_state` stores `customer_id` **as a column** — it is not part of the
  state JSON in §4. When real auth arrives, **the customer id comes from auth**.
- Policies are **markdown files in `data/policies`** (RAG) — **not** in the
  database.

---

## 14. Known limitations / stretch

| Item | Status |
| --- | --- |
| Auth is a fixed demo customer | Limitation |
| No product catalog | Limitation |
| No chat history on the server — follow-ups that depend on earlier messages (e.g. "and if it's broken?") are **not understood**; the customer must write the full question | Limitation |
| The UI still shows the whole conversation | By design |
| Stale state expiry (e.g. treat state older than 30 minutes as `idle`) | **Stretch** |
| A message history | **Possible stretch** |

---

## Decisions

The questions raised while drafting, and how they were settled.

| # | Decision |
| --- | --- |
| **Q1** | "Remembers the conversation" means **only** the workflow state in `session_state` — where it is in a flow. No chat history is stored (§1, §5) |
| **Q2** | `order_lookup` has its own flow (§10): no `orderId` → most recent order via `getLatestOrder(customerId)`, any status; with `orderId` → G1–G3, with G2 and G3 failing identically. State stays `idle`, no writes |
| **Q3** | `retries` is set to `0` on entering a pending step, so the limit is **per step**. Each unclear reply in **order selection** increments it; `retries > MAX_RETRIES` → `idle` with a polite message. `new_topic` resets everything (§4). Superseded for confirmation by Q8 |
| **Q4** | Colliding labels get `" - 1 of 2"` / `" - 2 of 2"` appended; the order date is already in the label (§6.2) |
| **Q5** | `options[].id` is the temporary number `n` as a string (e.g. `"2"`), never the real order id. Real ids appear in reply text only after the customer has selected an order (§6.2, §12) |
| **Q6** | `sources` = the policy answer's `usedSources`, filtered to file names actually present in the retrieved chunks (§8, §12) |
| **Q7** | No change to the state JSON. `session_state` already stores `customer_id` as a column of the row; with real auth, the customer id comes from auth (§13) |
| **Q8** | **Confirmation is binary; an unclear reply counts as `no` (fail-safe).** `interpretConfirmation` returns `'yes' \| 'no'` only, and the model answers `no` whenever it is unsure. The confirmation step never re-asks and does not use `retries` (§6.4, §11 G6) |
