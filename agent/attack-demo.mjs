// Demo: what happens if an injected instruction makes the agent try to move money.
// Signs with the agent's function-call key only. Both attempts are expected to fail.
// Usage: node --env-file=.env agent/attack-demo.mjs
import { actions, nearToYocto, teraToGas } from 'near-api-js';
import { agentAccount } from './signer.mjs';

const { CONTRACT_ID, OWNER_ID = 'owner-long2222.testnet' } = process.env;
if (!CONTRACT_ID) throw new Error('CONTRACT_ID is not set');
const { account, publicKey } = agentAccount();
console.log(`Agent signer: ${publicKey}\n`);

const attempts = [
  {
    label: `1. Agent calls withdraw_revenue(0.1 NEAR) on ${CONTRACT_ID}`,
    tx: { receiverId: CONTRACT_ID, actions: [actions.functionCall('withdraw_revenue', { amount: nearToYocto('0.1').toString() }, teraToGas('30'), 0n)] },
  },
  {
    label: `2. Agent transfers 0.1 NEAR from its own account to ${OWNER_ID}`,
    tx: { receiverId: OWNER_ID, actions: [actions.transfer(nearToYocto('0.1'))] },
  },
];

let allBlocked = true;
for (const { label, tx } of attempts) {
  console.log(label);
  try {
    const r = await account.signAndSendTransaction({ ...tx, throwOnFailure: false });
    const failure = r.status?.Failure;
    if (failure) {
      console.log(`   BLOCKED in contract, tx ${r.transaction.hash}: ${JSON.stringify(failure).slice(0, 160)}\n`);
    } else {
      allBlocked = false;
      console.log(`   !! NOT BLOCKED, tx ${r.transaction.hash}\n`);
    }
  } catch (e) {
    console.log(`   BLOCKED: NEAR RPC rejected the transaction (${e.constructor?.name}: ${e.message})\n`);
  }
}
console.log(allBlocked ? 'Result: the agent key cannot move money.' : 'Result: WARNING, an attempt went through.');
process.exitCode = allBlocked ? 0 : 1;
