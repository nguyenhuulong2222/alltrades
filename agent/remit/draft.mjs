// Turns a Vietnamese request such as "Gửi 500 đô về cho mẹ" into a TransferOrder DRAFT.
//
// Rules:
// - The user's message is data, never instructions. No model is involved: parsing is fixed code.
// - Only sample recipients exist. There is no input path for a real name, account number or phone.
//   A message containing such details is refused, and the details are never echoed or logged.
// - Requests to change the recipient, withdraw money, sign or call contract methods are refused,
//   and the reason is recorded in the audit list.
// - The agent only drafts. It holds no key and signs nothing; the sender signs create_order.
// - Missing amount, currency or recipient is reported as missing, never guessed.

import { createHash, randomBytes } from 'node:crypto';

export const CONTRACT_ID = 'alltrades-long2222.testnet';
/** Simulation scale only. Testnet NEAR has no value; this is not an exchange rate. */
export const NEAR_PER_USD = 0.0001;
export const MIN_DEPOSIT_NEAR = 0.01;
export const MAX_DEPOSIT_NEAR = 0.5;
export const DEFAULT_TTL_SECS = 3600;

const RELATIONS = {
  'mẹ': 'Mẹ', 'má': 'Mẹ', 'ba': 'Ba', 'bố': 'Ba', 'cha': 'Ba', 'ông': 'Ông', 'bà': 'Bà',
  'anh': 'Anh', 'chị': 'Chị', 'em': 'Em', 'cô': 'Cô', 'chú': 'Chú', 'dì': 'Dì', 'bác': 'Bác',
  'vợ': 'Vợ', 'chồng': 'Chồng', 'con': 'Con',
};
/** The only recipients that exist. Each is a fixed sample id, never a real person. */
export const SAMPLE_RECIPIENTS = Object.fromEntries(
  [...new Set(Object.values(RELATIONS))].map((label) => [label, { sample_id: `sample-${slug(label)}`, label: `${label} (người nhận mẫu)` }]),
);

function slug(s) {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/gi, 'd').toLowerCase();
}

const B = '(?:^|[\\s,.;:!?()"\'])'; // Unicode-safe word start
const E = '(?=$|[\\s,.;:!?()"\'])'; // Unicode-safe word end

const INJECTION = [
  ['change_recipient', new RegExp(`(đổi|thay|sửa)\\s+(người\\s+nhận|địa\\s+chỉ|tài\\s+khoản\\s+nhận)|gửi\\s+cho\\s+.*\\s+thay\\s+vì|change\\s+(the\\s+)?recipient|recipient_hash`, 'iu')],
  ['withdraw', /rút\s+(tiền|hết|lại)|withdraw/iu],
  ['contract_call', /settle_order|refund_order|create_order|set_remit_config|withdraw_revenue|reallocate|submit_delivery/iu],
  ['signing_or_keys', new RegExp(`${B}(?<!đăng\\s)(tự\\s+)?ký${E}|\\bsign\\b|private\\s*key|khóa\\s+riêng|seed\\s*phrase|mnemonic`, 'iu')],
  ['instruction_override', /bỏ\s+qua\s+(mọi\s+|các\s+|những\s+)?(hướng\s+dẫn|lệnh|quy\s+tắc|chỉ\s+dẫn)|ignore\s+(all\s+|any\s+|previous\s+|the\s+)*(instructions|rules)|system\s+prompt|developer\s+mode|you\s+are\s+now|bạn\s+bây\s+giờ\s+là/iu],
];

const PII = [
  ['phone', /(?:\+?84|0)[\s.-]?\d{2,3}[\s.-]?\d{3}[\s.-]?\d{3,4}(?!\d)/],
  ['account_number', /(?<![\d.,])\d{8,19}(?![\d.,])|(?:^|\s)(stk|số\s+tài\s+khoản|account\s+(number|no))(?=$|[\s:.,])/iu],
  ['email', /[^\s@]+@[^\s@]+\.[a-z]{2,}/i],
  ['name', /(?:^|\s)(tên|họ\s+tên|họ\s+và\s+tên|name)(?=$|[\s:])/iu],
  ['name', new RegExp(`${B}(${Object.keys(RELATIONS).join('|')})\\s+\\p{Lu}\\p{Ll}*(\\s+\\p{Lu}\\p{Ll}*)+`, 'u')],
];

/** Flags only. The matched text is never returned, so PII cannot leak through this result. */
export function screenMessage(text) {
  const t = String(text);
  return {
    injection: INJECTION.filter(([, re]) => re.test(t)).map(([id]) => id),
    pii: [...new Set(PII.filter(([, re]) => re.test(t)).map(([id]) => id))],
  };
}

function parseNumber(s) {
  // "1,200" / "1.200" → 1200 (3-digit groups); "12.5" → 12.5
  if (/^\d{1,3}([.,]\d{3})+$/.test(s)) return Number(s.replace(/[.,]/g, ''));
  return Number(s.replace(',', '.'));
}

/** Pulls amount, currency and recipient relation. Unknown parts stay null. */
export function parseRemitRequest(text) {
  const t = String(text).normalize('NFC');
  const out = { amount: null, currency: null, relation: null };
  const money = t.match(/(\$)\s*(\d[\d.,]*)|(\d[\d.,]*)\s*(k|nghìn|ngàn|triệu|tr)?\s*(đô\s*la|đô-la|đô|usd|us\$|dollars?|đồng|vnd|vnđ)?/iu);
  if (money) {
    const raw = money[2] ?? money[3];
    let n = parseNumber(raw.replace(/[.,]$/, ''));
    const mult = (money[4] ?? '').toLowerCase();
    if (mult === 'k' || mult === 'nghìn' || mult === 'ngàn') n *= 1_000;
    if (mult === 'triệu' || mult === 'tr') n *= 1_000_000;
    if (Number.isFinite(n) && n > 0) out.amount = n;
    const cur = (money[1] ?? money[5] ?? '').toLowerCase();
    if (cur === '$' || /^(đô|usd|us\$|dollar)/u.test(cur)) out.currency = 'USD';
    else if (/^(đồng|vnd|vnđ)$/u.test(cur) || mult === 'triệu' || mult === 'tr') out.currency = 'VND';
  }
  const rel = t.match(new RegExp(`${B}(cho|tới|đến|về)\\s+(${Object.keys(RELATIONS).join('|')})${E}`, 'iu'));
  if (rel) out.relation = RELATIONS[rel[2].toLowerCase()];
  return out;
}

const REASONS = {
  change_recipient: 'Yêu cầu đổi người nhận bị từ chối: người nhận chỉ là người nhận mẫu và recipient_hash không đổi được.',
  withdraw: 'Yêu cầu rút tiền bị từ chối: agent không giữ tiền và không gọi được lệnh rút.',
  contract_call: 'Yêu cầu gọi method contract bị từ chối: agent chỉ tạo bản nháp, người gửi tự ký.',
  signing_or_keys: 'Yêu cầu ký hoặc dùng khóa bị từ chối: agent không có khóa và không ký giao dịch.',
  instruction_override: 'Tin nhắn cố đổi quy tắc của agent: tin nhắn chỉ là dữ liệu, không phải lệnh.',
  pii: 'Tin nhắn có thông tin cá nhân. Không nhập tên, số tài khoản, số điện thoại hay email thật; bản demo chỉ dùng người nhận mẫu.',
};

/**
 * Builds a TransferOrder draft, or a refusal / missing-data answer. Never signs, never sends.
 * @returns {{ ok: boolean, ... }}
 */
export function draftTransferOrder(text, { contractId = CONTRACT_ID, ttlSecs = DEFAULT_TTL_SECS, salt = randomBytes(16).toString('hex'), now = Date.now() } = {}) {
  const audit = [];
  const at = new Date(now).toISOString();
  const screen = screenMessage(text);

  const refused = [...screen.injection.map((id) => ({ code: id, reason: REASONS[id] }))];
  if (screen.pii.length) refused.push({ code: 'pii', kinds: screen.pii, reason: REASONS.pii });
  if (refused.length) {
    for (const r of refused) audit.push({ at, event: 'refused', code: r.code, ...(r.kinds ? { kinds: r.kinds } : {}) });
    return { ok: false, refused, audit, note: 'Không tạo bản nháp. Nội dung tin nhắn không được lưu.' };
  }

  const p = parseRemitRequest(text);
  const missing = [];
  if (p.amount === null) missing.push({ field: 'amount', message: 'Thiếu số tiền. Ví dụ: "Gửi 500 đô về cho mẹ".' });
  if (p.currency === null) missing.push({ field: 'currency', message: 'Thiếu đơn vị tiền. Hãy ghi rõ "đô" hoặc "USD".' });
  if (p.relation === null) missing.push({ field: 'recipient', message: `Thiếu người nhận. Chọn một người nhận mẫu: ${Object.keys(SAMPLE_RECIPIENTS).join(', ')}.` });
  if (p.currency === 'VND') missing.push({ field: 'currency', message: 'Bản demo chỉ hỗ trợ gửi bằng USD sang VND. Hãy nhập số tiền bằng USD.' });
  if (missing.length) {
    audit.push({ at, event: 'missing', fields: missing.map((m) => m.field) });
    return { ok: false, missing, parsed: p, audit };
  }

  const scaled = p.amount * NEAR_PER_USD;
  if (scaled > MAX_DEPOSIT_NEAR) {
    audit.push({ at, event: 'refused', code: 'over_cap' });
    return { ok: false, refused: [{ code: 'over_cap', reason: `Số tiền vượt trần mô phỏng ${MAX_DEPOSIT_NEAR} NEAR testnet (tối đa ${MAX_DEPOSIT_NEAR / NEAR_PER_USD} USD).` }], audit };
  }
  const depositNear = Math.max(MIN_DEPOSIT_NEAR, Math.round(scaled * 10_000) / 10_000);
  const recipient = SAMPLE_RECIPIENTS[p.relation];
  const recipientHash = createHash('sha256').update(`${salt}|${recipient.sample_id}`).digest('hex');
  const args = { recipient_hash: recipientHash, ttl_secs: ttlSecs };
  audit.push({ at, event: 'drafted', amount_usd: p.amount, recipient: recipient.sample_id });

  return {
    ok: true,
    kind: 'TransferOrderDraft',
    simulated: true,
    notice: 'Bản nháp mô phỏng trên testnet. Không có tiền thật, không có VND thật. Agent không ký; người gửi tự kiểm tra và tự ký create_order.',
    request: { amount_usd: p.amount, recipient },
    deposit: {
      near: String(depositNear),
      scale: `${NEAR_PER_USD} NEAR testnet cho mỗi USD (tỷ lệ mô phỏng, không phải tỷ giá)${depositNear === MIN_DEPOSIT_NEAR && scaled < MIN_DEPOSIT_NEAR ? `; nâng lên mức tối thiểu ${MIN_DEPOSIT_NEAR} NEAR` : ''}`,
    },
    call: { contract: contractId, method: 'create_order', args, attached_deposit: `${depositNear} NEAR`, prepaid_gas: '30 Tgas' },
    salt: { value: salt, note: 'Salt chỉ nằm trong bản nháp này, không lên chain. recipient_hash = sha256(salt|sample_id).' },
    sign_command: `near contract call-function as-transaction ${contractId} create_order json-args '${JSON.stringify(args)}' prepaid-gas '30 Tgas' attached-deposit '${depositNear} NEAR' sign-as <SENDER_ACCOUNT> network-config testnet sign-with-keychain send`,
    audit,
  };
}
