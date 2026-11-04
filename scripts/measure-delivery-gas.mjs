// Measures the real gas of submit_delivery_v2 with a large deliverable (testnet only).
// Sends clearly labelled FILLER text, not real work, with cost 0, through the worker's own
// function-call key and chain adapter. Use it on a job you will dispute and refund.
//
//   node --env-file=.env scripts/measure-delivery-gas.mjs <job_id> [bytes=4090]

import { nearChain } from '../agent/worker.mjs';
import { sha256 } from '../agent/lib.mjs';

export function fillerText(bytes) {
  const head = 'GAS MEASUREMENT FILLER, not a deliverable. Fictional demo job only. ';
  const body = 'Lorem ipsum filler for a size test on NEAR testnet. ';
  let t = head;
  while (Buffer.byteLength(t) + body.length <= bytes) t += body;
  return t + 'x'.repeat(bytes - Buffer.byteLength(t));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const jobId = Number(process.argv[2]);
  const bytes = Number(process.argv[3] ?? 4090);
  if (!Number.isInteger(jobId) || bytes < 1 || bytes > 4096) {
    console.error('Usage: node --env-file=.env scripts/measure-delivery-gas.mjs <job_id> [bytes<=4096]');
    process.exit(2);
  }
  const chain = await nearChain(process.env);
  const job = await chain.getJob(jobId);
  if (job?.status !== 'Open') throw new Error(`Job ${jobId} is not Open (${job?.status})`);
  const text = fillerText(bytes);
  const tx = await chain.submitDelivery({ jobId, hash: sha256(text), cost: '0', text });
  console.log(JSON.stringify({ jobId, bytes: Buffer.byteLength(text), tx }));
}
