import type { Context } from 'hono';
import type { AppContext } from "../../types";
import { getOrCreateToken } from '../../lib/reg/tokens';
import { loadTablesConfig, getTable, formatCutoffTime } from '../../lib/reg/tables';
import { sendMagicLink } from '../../lib/reg/email';


export async function handleSendMagicLink(c: AppContext) {
  const bookingId = c.req.param('bookingId') ?? '';

  const booking = await c.env.DB.prepare(
    'SELECT * FROM reg_bookings WHERE id = ?',
  ).bind(bookingId).first();

  if (!booking) {
    return c.json({ success: false, message: 'Booking not found.' }, 404);
  }

  const b = booking as Record<string, unknown>;
  const buyerEmail = String(b.buyer_email || '').trim();

  if (!buyerEmail) {
    return c.json({ success: false, message: 'No buyer email on file. Add an email to this booking first.' }, 400);
  }

  const config = await loadTablesConfig(c.env.SWA_CONFIG);
  const table = getTable(config, String(b.table_id));

  const token = await getOrCreateToken(c.env.DB, bookingId, config.formCutoffTime);

  const baseUrl = c.env.SWA_ADMIN_DOMAIN
    ? `https://${c.env.SWA_ADMIN_DOMAIN}`
    : 'https://admin.singaporewomenassociation.org';
  const magicLinkUrl = `${baseUrl}/reg/buyer/?token=${token}`;

  c.executionCtx.waitUntil(
    sendMagicLink(c.env, {
      buyerEmail,
      buyerName: String(b.buyer_name),
      bookingRef: String(b.booking_ref),
      paxCount: Number(b.pax),
      tableLabel: table ? table.label : String(b.table_id),
      magicLinkUrl,
      formCutoffFormatted: formatCutoffTime(config),
    }).catch((err) => {
      console.error('[REG MAGIC LINK] Failed to send:', err);
    }),
  );

  return c.json({
    success: true,
    message: `Magic link sent to ${buyerEmail}.`,
    token,
  });
}