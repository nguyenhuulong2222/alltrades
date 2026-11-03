import { Account, JsonRpcProvider, KeyPair } from 'near-api-js';

// Public key of the agent's function-call key (submit_delivery, reallocate only). Not a secret.
export const EXPECTED_AGENT_PUBLIC_KEY = 'ed25519:4UG4RCFqw2sSdXn7gAWLYXSkPjVH9NaiMpyK5nNuoQ4r';
export const RPC_URL = process.env.NEAR_RPC_URL ?? 'https://rpc.testnet.near.org';

// Derives the public key and refuses to continue unless it matches. Never logs the secret.
export function checkedKeyPair(secret, expected = EXPECTED_AGENT_PUBLIC_KEY) {
  if (!secret) throw new Error('AGENT_FC_PRIVATE_KEY is not set');
  let keyPair;
  try {
    keyPair = KeyPair.fromString(secret);
  } catch {
    throw new Error('AGENT_FC_PRIVATE_KEY is not a valid ed25519 key');
  }
  const actual = keyPair.getPublicKey().toString();
  if (actual !== expected) throw new Error(`Agent key mismatch: got ${actual}, expected ${expected}`);
  return keyPair;
}

export function agentAccount(env = process.env) {
  if (!env.AGENT_ID) throw new Error('AGENT_ID is not set');
  const keyPair = checkedKeyPair(env.AGENT_FC_PRIVATE_KEY);
  const provider = new JsonRpcProvider({ url: RPC_URL });
  return { account: new Account(env.AGENT_ID, provider, keyPair.toString()), provider, publicKey: keyPair.getPublicKey().toString() };
}
