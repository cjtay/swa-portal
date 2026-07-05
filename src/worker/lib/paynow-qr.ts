/**
 * PayNow QR payload builder (EMVCo Merchant-Presented QR + SG.PAYNOW).
 *
 * Pure functions — no I/O, no globals. Safe to run on the Cloudflare Workers
 * V8 runtime AND in the browser. The same code is inlined into the membership
 * form page script so the client can render the QR live as the user types
 * their name; the server does NOT need to build the string (the QR is purely
 * client-side rendering of a deterministic string).
 *
 * Ported from the gtw2026 project (src/pages/gtw-form/index.astro) which has
 * been used in production for SWA gala ticketing. The payload format follows
 * the EMVCo QR Specification v1.1 with the SG.PAYNOW extension (proxy value
 * = UEN). The trailing CRC uses CRC-16/CCITT-FALSE (poly 0x1021, init 0xFFFF)
 * per ISO/IEC 13239 — this is what every SG banking app expects.
 */

/** ID + length-prefixed TLV field, per EMVCo. Length is 2-digit zero-padded. */
export function formatField(id: string, value: string): string {
  const len = String(value.length).padStart(2, '0');
  return `${id}${len}${value}`;
}

/** CRC-16/CCITT-FALSE (poly 0x1021, init 0xFFFF), returned as 4 hex digits. */
export function crc16(str: string): string {
  let crc = 0xffff;
  for (let i = 0; i < str.length; i++) {
    crc ^= str.charCodeAt(i) << 8;
    for (let j = 0; j < 8; j++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

export interface PayNowParams {
  /** Registered PayNow UEN proxy value (e.g. 'S54SS0010L'). */
  uen: string;
  /** Payment amount in SGD. Amount is locked (not editable by the payer). */
  amount: number;
  /** Merchant name shown by the banking app (max 25 chars). */
  merchantName: string;
  /** Bill payment reference (max 25 chars). Appears in the merchant's statement. */
  refNumber: string;
  /** Optional expiry date as YYYYMMDD. Omit for a non-expiring QR. */
  expiry?: string;
}

/**
 * Build the full PayNow QR payload string. Pass the result to a QR encoder.
 */
export function generatePayNowString({ uen, amount, merchantName, refNumber, expiry }: PayNowParams): string {
  // Field 26 — SG.PAYNOW merchant account information.
  let paynow = '';
  paynow += formatField('00', 'SG.PAYNOW');
  paynow += formatField('01', '2'); // proxy type: 2 = UEN
  paynow += formatField('02', uen);
  paynow += formatField('03', '0'); // amount editability: 0 = NOT editable
  if (expiry) paynow += formatField('04', expiry);

  // Field 62 — additional data, sub-field 01 = bill payment reference.
  const additional = formatField('01', refNumber.substring(0, 25));

  let str = '';
  str += formatField('00', '01'); // payload format indicator
  str += formatField('01', '12'); // 12 = dynamic / one-time QR
  str += formatField('26', paynow);
  str += formatField('52', '0000'); // merchant category code
  str += formatField('53', '702'); // currency: 702 = SGD
  str += formatField('54', amount.toFixed(2));
  str += formatField('58', 'SG');
  str += formatField('59', merchantName.substring(0, 25));
  str += formatField('60', 'Singapore');
  str += formatField('62', additional);
  str += '6304'; // CRC field ID + length placeholder

  return str + crc16(str);
}

/**
 * Build a bill reference of the form `MEM-<NAME-SLUG>-<XXXX>` from a full
 * name. Used as both the PayNow bill reference (field 62.01) and the
 * human-readable application reference shown to the user.
 *
 *   slug  : A–Z0–9 only, non-alphanumerics stripped, uppercased, ≤ 12 chars
 *   suffix: 4 random base36 chars from crypto.getRandomValues
 *
 * Total length ≤ 25 chars to fit PayNow's reference field. The slug derives
 * from the user's name (per product requirement) and the random suffix
 * guarantees uniqueness across applicants with the same name.
 */
export function buildMembershipReference(fullName: string, randomSuffix: string): string {
  const slug = fullName
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 12);
  const suffix = randomSuffix
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 4)
    .padEnd(4, '0');
  return `MEM-${slug}-${suffix}`;
}
