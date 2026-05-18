export interface TokenRow {
  token: string;
  booking_id: string;
  created_at: string;
  expires_at: string;
}

export async function createToken(
  db: D1Database,
  bookingId: string,
  expiresAt: string,
): Promise<string> {
  const tokenBytes = new Uint8Array(16);
  crypto.getRandomValues(tokenBytes);
  const token = Array.from(tokenBytes, (b) => b.toString(16).padStart(2, '0')).join('');

  await db.prepare(
    'INSERT INTO reg_tokens (token, booking_id, created_at, expires_at) VALUES (?, ?, datetime(\'now\'), ?)',
  )
    .bind(token, bookingId, expiresAt)
    .run();

  return token;
}

export async function validateToken(
  db: D1Database,
  token: string,
): Promise<TokenRow | null> {
  const result = await db.prepare(
    'SELECT * FROM reg_tokens WHERE token = ?',
  )
    .bind(token)
    .first();

  if (!result) return null;

  const row = result as unknown as TokenRow;

  const expiresAt = new Date(row.expires_at);
  if (expiresAt < new Date()) return null;

  return row;
}

export async function getTokenByBooking(
  db: D1Database,
  bookingId: string,
): Promise<TokenRow | null> {
  const result = await db.prepare(
    'SELECT * FROM reg_tokens WHERE booking_id = ?',
  )
    .bind(bookingId)
    .first();

  return result as unknown as TokenRow | null;
}

export async function getOrCreateToken(
  db: D1Database,
  bookingId: string,
  expiresAt: string,
): Promise<string> {
  const existing = await getTokenByBooking(db, bookingId);
  if (existing) {
    const expiresAtDate = new Date(existing.expires_at);
    if (expiresAtDate >= new Date()) {
      return existing.token;
    }
  }

  return createToken(db, bookingId, expiresAt);
}