// USD→VND cost context for a simulated transfer. Information only:
// every figure carries its source and data period, nothing picks a provider,
// and missing data is reported as missing instead of being estimated.
// Nothing here writes to disk; live rates stay in memory.

import { readFileSync } from 'node:fs';
import { ESTIMATE_LABEL } from '../lib.mjs';

export const ER_API_URL = 'https://open.er-api.com/v6/latest/USD';
export const ER_API_ATTRIBUTION = 'Rates By Exchange Rate API';
export const WORLD_BANK_SAMPLE = new URL('./data/worldbank-rpw-usa-vnm.sample.json', import.meta.url);

/** Loads the committed World Bank corridor file. Today this is sample data only. */
export function loadWorldBankCorridor(path = WORLD_BANK_SAMPLE) {
  const d = JSON.parse(readFileSync(path, 'utf8'));
  for (const k of ['source_name', 'source_url', 'corridor', 'period', 'average_total_cost_pct', 'send_amount_usd']) {
    if (d[k] === undefined) throw new Error(`World Bank corridor file missing ${k}`);
  }
  return d;
}

/** Mid-market reference rate fetched at run time. Not committed, not cached to disk. */
export async function fetchReferenceRate({ fetchImpl = fetch, timeoutMs = 10_000 } = {}) {
  const res = await fetchImpl(ER_API_URL, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`ExchangeRate-API HTTP ${res.status}`);
  const j = await res.json();
  const vnd = j?.rates?.VND;
  if (j?.result !== 'success' || typeof vnd !== 'number' || !(vnd > 0)) throw new Error('ExchangeRate-API returned no USD→VND rate');
  return {
    rate: vnd,
    updatedAt: j.time_last_update_utc,
    nextUpdate: j.time_next_update_utc,
    source: 'https://www.exchangerate-api.com',
    attribution: ER_API_ATTRIBUTION,
  };
}

const fmt = (n, d = 2) => Number(n).toLocaleString('en-US', { maximumFractionDigits: d, minimumFractionDigits: 0 });

/**
 * Builds the comparison. Each section is either { status: 'ok', ... } with source and period,
 * or { status: 'missing', reason }. No section is ever filled with a guess.
 */
export function buildComparison({ amountUsd, corridor = null, fx = null, quote = null }) {
  const sections = [];

  if (corridor) {
    const fee = (amountUsd * corridor.average_total_cost_pct) / 100;
    sections.push({
      id: 'corridor_cost', status: 'ok', sample: corridor.sample === true,
      text: `${corridor.sample ? '(MẪU, không phải số liệu thật) ' : ''}Chi phí trung bình hành lang ${corridor.corridor}: ${corridor.average_total_cost_pct}% (khi gửi ${corridor.send_amount_usd} USD). Áp cho ${fmt(amountUsd)} USD: khoảng ${fmt(fee)} USD.`,
      source: corridor.source_name, source_url: corridor.source_url, period: corridor.period,
    });
  } else {
    sections.push({ id: 'corridor_cost', status: 'missing', reason: 'Không có dữ liệu chi phí hành lang USD→VND; không ước tính.' });
  }

  if (fx) {
    sections.push({
      id: 'reference_rate', status: 'ok',
      text: `${fx.fixture ? '(FIXTURE, không phải tỷ giá thật) ' : ''}Tỷ giá tham khảo giữa thị trường: 1 USD = ${fmt(fx.rate, 0)} VND. ${fmt(amountUsd)} USD ≈ ${fmt(amountUsd * fx.rate, 0)} VND trước phí.`,
      source: fx.attribution, source_url: fx.source, period: `cập nhật ${fx.updatedAt}`,
    });
  } else {
    sections.push({ id: 'reference_rate', status: 'missing', reason: 'Không lấy được tỷ giá tham khảo USD→VND; không tự đoán tỷ giá.' });
  }

  if (quote) {
    const cost = Number(quote.amountInUsd) - Number(quote.amountOutUsd);
    sections.push({
      id: 'stablecoin_leg', status: 'ok',
      text: `${quote.fixture ? '(FIXTURE, không phải báo giá thật) ' : ''}Chặng stablecoin ${quote.pair}: vào ${quote.amountIn}, ra ${quote.amountOut} (chênh khoảng ${fmt(cost)} USD), khoảng ${quote.timeEstimateSec} giây.`,
      source: quote.source, source_url: 'https://docs.near-intents.org', period: `dry quote lúc ${quote.fetchedAt}`,
    });
  } else {
    sections.push({ id: 'stablecoin_leg', status: 'missing', reason: 'Không có dry quote 1Click; không ước tính chặng stablecoin.' });
  }

  return { label: ESTIMATE_LABEL, amountUsd, sections };
}

/** Plain-text summary for the user. Every line shows source and period; no provider is chosen. */
export function renderComparison(c) {
  const lines = [`Chi phí tham khảo cho ${fmt(c.amountUsd)} USD → VND (${c.label}):`];
  for (const s of c.sections) {
    lines.push(s.status === 'ok' ? `- ${s.text} Nguồn: ${s.source}. Kỳ dữ liệu: ${s.period}.` : `- Thiếu dữ liệu: ${s.reason}`);
  }
  lines.push('Thông tin này chỉ để tham khảo. Người gửi tự quyết định dịch vụ và tự ký giao dịch.');
  return lines.join('\n');
}
