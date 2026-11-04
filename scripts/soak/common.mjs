// Shared pieces for the autopilot soak run (testnet only).
// - Reads go through public RPC (scripts/view.mjs). No keys.
// - Writes go through near-cli with the macOS keychain of owner/client accounts. This module
//   never reads .env and never prints near-cli output: it extracts only the transaction ID or
//   the first contract error line.

import { execFile } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { account, coreState, query, view } from '../view.mjs';

export const CONTRACT = 'alltrades-long2222.testnet';
export const OWNER = 'owner-long2222.testnet';
export const CLIENT = 'client-long2222.testnet';
export const WORKER = 'worker-long2222.testnet';
export const WORKER_KEY = 'ed25519:DKwir2bYP2CF1yTnrmY5u1hoMpRW6pMZmqftJ1fz8byP';
export const YOCTO = 10n ** 24n;
export const toNear = (y) => Number(BigInt(y) / 10n ** 18n) / 1e6;
export const nearToYocto = (n) => (BigInt(Math.round(n * 1e6)) * 10n ** 18n).toString();

/** Builds the near-cli arguments for a contract call (pure, testable). */
export function callArgs({ method, args, signer, deposit = '0 NEAR', gas = '30 Tgas', contract = CONTRACT }) {
  return ['contract', 'call-function', 'as-transaction', contract, method, 'json-args', JSON.stringify(args),
    'prepaid-gas', gas, 'attached-deposit', deposit, 'sign-as', signer, 'network-config', 'testnet', 'sign-with-keychain', 'send'];
}

/** Extracts the tx hash or the contract error from near-cli output. Never returns the raw output. */
export function parseCliOutput(text) {
  const clean = String(text).replace(/\x1b\[[0-9;]*m/g, '');
  const tx = clean.match(/Transaction ID:\s*([1-9A-HJ-NP-Za-km-z]{43,44})/)?.[1] ?? null;
  const err = clean.match(/Smart contract panicked: ([^"\n)]{1,160})/)?.[1]
    ?? (/(^|\n)\s*(Error|error):/.test(clean) && !tx ? 'near-cli error (details withheld)' : null);
  return { tx, error: err };
}

export async function nearCall(opts, run = promisify(execFile)) {
  let out = '';
  try {
    const r = await run('near', callArgs(opts), { timeout: 180_000 });
    out = `${r.stdout}\n${r.stderr}`;
  } catch (e) {
    out = `${e.stdout ?? ''}\n${e.stderr ?? ''}\nerror:`;
  }
  const { tx, error } = parseCliOutput(out);
  if (error || !tx) throw new Error(`${opts.method}: ${error ?? 'no transaction ID'}`);
  return tx;
}

export async function allowance(accountId = WORKER, publicKey = WORKER_KEY) {
  const r = await query({ request_type: 'view_access_key', account_id: accountId, public_key: publicKey });
  const fc = r.permission?.FunctionCall;
  return fc ? fc.allowance : null;
}

export async function v2Jobs() {
  const cfg = await view('get_autopilot');
  const jobs = [];
  for (let from = 0; from < Number(cfg.next_job_id); from += 50) jobs.push(...(await view('get_jobs_v2', { from, limit: 50 })));
  return { cfg, jobs };
}

/** Everything the monitor compares, in one read. */
export async function snapshot() {
  const [core, industries, { cfg, jobs }, contract, client, worker, owner, allow] = await Promise.all([
    coreState(), view('get_industries'), v2Jobs(), account(CONTRACT), account(CLIENT), account(WORKER), account(OWNER), allowance(),
  ]);
  return { at: new Date().toISOString(), core, industries, autopilot: cfg, jobs, balances: { contract: contract.amount, client: client.amount, worker: worker.amount, owner: owner.amount }, allowance: allow };
}

export function logger(path) {
  return (event, data = {}) => {
    const line = JSON.stringify({ t: new Date().toISOString(), event, ...data });
    appendFileSync(path, `${line}\n`);
    console.log(line);
  };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
