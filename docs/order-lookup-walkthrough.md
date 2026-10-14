# Order lookup — walkthrough

Describes the code as it is today, not the plan. Source: `src/lib/agent.ts`,
`src/lib/tools.ts`, `src/lib/gates.ts`, `src/lib/llm.ts`.

## 1. What this flow does

The customer asks where an order is. The code finds the order, builds a short
list of **facts** (plain text the model is allowed to use), and the LLM turns
those facts into a friendly reply. If the customer gave no order number, the
code uses their most recent order instead.

## 2. Big picture

```
            customer message + sessionId
                        |
                        v
        [CODE] gateMessage  (G9)  ---- fails ---> [CODE] refusal()
          src/lib/gates.ts                        intent: out_of_scope
                        | ok                              |
                        v                                 v
        [DB] sessions.getState(sessionId)            response JSON
             (loaded + logged, never saved)
                        |
                        v
        [LLM] classifyIntent  -> intent, orderId
                        |
                        v
        [CODE] branch on orderId
                        |
        +---------------+-------------------+
        |                                   |
   orderId is null or ''              orderId is given
        |                                   |
        v                                   v
  [DB] getLatestOrder          [CODE] lookupOrder (src/lib/tools.ts)
       (customerId)                         |
        |                          G1 format -- fails --> userMessage
   +----+-----+                             |
   |          |                     [DB] getOrder(orderId)
 null     an order                          |
   |          |                      G2 exists -- fails --> not found
   v          v                              |
NO_ORDERS  orderFacts()              G3 is it yours -- fails --> not found
 _FACT     + MOST_RECENT                     | ok                (same text)
   |        _ORDER_FACT                      v
   |          |                        orderFacts(order)
   +----+-----+--------------------------+---+
                        |
                        v
        [LLM] writeReply({ intent, facts, customerMessage })
                        |
                        v
        [CODE] build ChatResponse + validateResponse (G7)
                        |
                        v
                  response JSON
```


