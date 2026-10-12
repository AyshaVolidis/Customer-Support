// Scratch script for running things by hand:
//   npm run try -- db                                    (default) read-only DB smoke test
//   npm run try -- model "say hi in one sentence"        one generateText call
//   npm run try -- classify "<message>" [offered]        classifyIntent; "offered" sets
//                                                        handoffOffered = true
//   npm run try -- reply "<message>" "<facts>" [intent]  writeReply; intent defaults
//                                                        to order_lookup
//   npm run try -- chat <sessionId> "<message>"          handleMessage end to end
//
// Temporary: this is a scratch harness, not part of the workflow.

import { generateText } from 'ai';

import { handleMessage } from '../lib/agent';
import { DEMO_CUSTOMER_ID } from '../lib/config';
import { classifyIntent, writeReply } from '../lib/llm';
import { getModel } from '../lib/model';
import { getRepositories } from '../lib/repositories';
import { IntentSchema, type Intent } from '../lib/schema';

/** Read-only order checks, plus one session_state round trip. */
async function tryDatabase(): Promise<void> {
  const { orders, sessions } = getRepositories();

  console.log('--- order 1002 ---');
  console.log(await orders.getOrder('1002'));

  console.log(`\n--- latest order for ${DEMO_CUSTOMER_ID} ---`);
  console.log(await orders.getLatestOrder(DEMO_CUSTOMER_ID));

  console.log(`\n--- cancellable orders for ${DEMO_CUSTOMER_ID} ---`);
  console.log(await orders.getCancellableOrders(DEMO_CUSTOMER_ID));

  // A unique session id per run, so repeated runs never collide.
  const sessionId = `try-${Date.now()}`;

  console.log(`\n--- set state for ${sessionId} ---`);
  await sessions.setState(sessionId, DEMO_CUSTOMER_ID, {
    step: 'awaiting_confirmation',
    selectedOrderId: '1005',
  });
  console.log('written');

  console.log(`\n--- read it back ---`);
  console.log(await sessions.getState(sessionId));

  console.log(`\n--- read an unknown session (expect idle) ---`);
  console.log(await sessions.getState('try-does-not-exist'));
}

/** One generateText call, to check the model and API key work. */
async function tryModel(prompt: string): Promise<void> {
  console.log(`--- prompt ---\n${prompt}\n`);

  const result = await generateText({
    model: getModel(),
    prompt,
  });

  console.log(`--- response ---\n${result.text}`);
}

/** One classifyIntent call, printed as JSON. */
async function tryClassify(message: string, handoffOffered: boolean): Promise<void> {
  const result = await classifyIntent({ message, handoffOffered });

  console.log(`\n--- classification (handoffOffered: ${String(handoffOffered)}) ---`);
  console.log(JSON.stringify(result, null, 2));
}

/** One writeReply call, printing the phrased reply. */
async function tryReply(message: string, facts: string, intent: Intent): Promise<void> {
  const reply = await writeReply({ intent, facts, customerMessage: message });

  console.log(`\n--- reply (intent: ${intent}) ---`);
  console.log(reply);
}

/** One full handleMessage round trip, printed as JSON. */
async function tryChat(sessionId: string, message: string): Promise<void> {
  const response = await handleMessage(sessionId, message);

  console.log(`\n--- response (session: ${sessionId}) ---`);
  console.log(JSON.stringify(response, null, 2));
}

async function main(): Promise<void> {
  const [mode = 'db', ...rest] = process.argv.slice(2);

  if (mode === 'db') {
    await tryDatabase();
    return;
  }

  if (mode === 'model') {
    const prompt = rest.join(' ').trim();
    if (!prompt) {
      throw new Error('Usage: npm run try -- model "your prompt here"');
    }
    await tryModel(prompt);
    return;
  }

  if (mode === 'classify') {
    // The last word may be the literal flag "offered".
    const handoffOffered = rest.at(-1) === 'offered';
    const words = handoffOffered ? rest.slice(0, -1) : rest;
    const message = words.join(' ').trim();

    if (!message) {
      throw new Error('Usage: npm run try -- classify "your message here" [offered]');
    }
    await tryClassify(message, handoffOffered);
    return;
  }

  if (mode === 'reply') {
    const [message, facts, intentArg] = rest;

    if (!message || !facts) {
      throw new Error('Usage: npm run try -- reply "<message>" "<facts>" [intent]');
    }

    // intent is optional on the CLI; the real caller always passes one.
    const parsedIntent = IntentSchema.safeParse(intentArg ?? 'order_lookup');
    if (!parsedIntent.success) {
      throw new Error(`Unknown intent "${String(intentArg)}". See IntentSchema for the five.`);
    }

    await tryReply(message, facts, parsedIntent.data);
    return;
  }

  if (mode === 'chat') {
    const [sessionId, ...words] = rest;
    const message = words.join(' ').trim();

    if (!sessionId || !message) {
      throw new Error('Usage: npm run try -- chat <sessionId> "<message>"');
    }

    await tryChat(sessionId, message);
    return;
  }

  throw new Error(`Unknown mode "${mode}". Use "db", "model", "classify", "reply" or "chat".`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
