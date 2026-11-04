// Public catalog of FICTIONAL briefs. A Jobs v2 job only carries brief_id + brief_hash;
// the worker only works on a job whose hash matches the catalog text exactly.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sha256 } from '../lib.mjs';

export const MAX_BRIEF_CHARS = 1000;
const ID = /^[a-z0-9-]{1,40}$/;
const PII = [
  ['phone', /(?:\+?\d[\s.-]?)?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b/],
  ['email', /[^\s@]+@[^\s@]+\.[a-z]{2,}/i],
  ['long_number', /\b\d{8,}\b/],
];

/** Throws if a brief is not safe to publish and work on. */
export function validateBrief(b, { industries } = {}) {
  if (!ID.test(b?.id ?? '')) throw new Error(`Brief id must match ${ID}`);
  if (b.fictional !== true) throw new Error(`Brief ${b.id} must be marked fictional`);
  if (typeof b.brief !== 'string' || !b.brief.trim()) throw new Error(`Brief ${b.id} has no text`);
  if (b.brief.length > MAX_BRIEF_CHARS) throw new Error(`Brief ${b.id} is over ${MAX_BRIEF_CHARS} characters`);
  if (industries && !industries.has(b.industry)) throw new Error(`Brief ${b.id} uses unknown industry ${b.industry}`);
  const hit = PII.find(([, re]) => re.test(b.brief));
  if (hit) throw new Error(`Brief ${b.id} looks like it contains personal data (${hit[0]})`);
  return { ...b, hash: sha256(b.brief) };
}

/** id → { id, industry, brief, hash }. The file name must equal the id. */
export function loadBriefs(dir, { industries } = {}) {
  const out = new Map();
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.json'))) {
    const b = validateBrief(JSON.parse(readFileSync(join(dir, f), 'utf8')), { industries });
    if (`${b.id}.json` !== f) throw new Error(`Brief file ${f} must be named ${b.id}.json`);
    out.set(b.id, b);
  }
  return out;
}
