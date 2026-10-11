// Scratch script for running the agent by hand: npm run try
// Reads orders (cancels nothing) and round-trips one session_state row.

import { DEMO_CUSTOMER_ID } from '../lib/config';
import { getRepositories } from '../lib/repositories';

async function main(): Promise<void> {
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

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
