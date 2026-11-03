import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const REQUIRED = ['id', 'name', 'tasks', 'price_near', 'max_cost_near', 'risk', 'system_prompt', 'quality'];
const BLOCKED_RISK = new Set(['medical', 'legal', 'financial', 'tax']);

export function validatePack(pack) {
  for (const key of REQUIRED) if (pack[key] === undefined) throw new Error(`Pack missing ${key}`);
  if (BLOCKED_RISK.has(pack.risk)) throw new Error(`Risk ${pack.risk} needs a licensed human`);
  if (pack.max_cost_near >= pack.price_near) throw new Error(`Pack ${pack.id} cannot make a profit`);
  return pack;
}

export function loadPacks(dir) {
  const packs = new Map();
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
    const pack = validatePack(JSON.parse(readFileSync(join(dir, file), 'utf8')));
    packs.set(pack.id, pack);
  }
  return packs;
}

export function checkQuality(text, pack) {
  const { min_chars, max_chars, must_not_include } = pack.quality;
  const lower = text.toLowerCase();
  if (text.length < min_chars) return { ok: false, reason: 'too_short' };
  if (text.length > max_chars) return { ok: false, reason: 'too_long' };
  const hit = must_not_include.find((w) => lower.includes(w.toLowerCase()));
  return hit ? { ok: false, reason: `blocked_phrase:${hit}` } : { ok: true };
}

export const sha256 = (text) => createHash('sha256').update(text).digest('hex');

const YOCTO = 10n ** 24n;
export const near = (yocto) => Number(BigInt(yocto) * 1000n / YOCTO) / 1000;
export const toYocto = (value) => (BigInt(Math.round(value * 1000)) * YOCTO / 1000n).toString();

export function profit(i) {
  return near(i.revenue) - near(i.spent);
}

/** Fixed rule, no LLM: move 20% of free budget from the worst to the best industry. */
export function planReallocation(industries, minJobs = 3) {
  const ranked = industries
    .filter(([, i]) => i.enabled && i.jobs_paid + i.jobs_refunded >= minJobs)
    .map(([name, i]) => ({ name, i, p: profit(i) }))
    .sort((a, b) => b.p - a.p);
  if (ranked.length < 2) return null;
  const best = ranked[0];
  const worst = ranked.at(-1);
  if (best.p <= 0 || worst.p >= 0) return null;
  const free = near(worst.i.budget) - near(worst.i.spent);
  const amount = Math.floor(free * 0.2 * 1000) / 1000;
  return amount > 0 ? { from: worst.name, to: best.name, amount: toYocto(amount) } : null;
}
