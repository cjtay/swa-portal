import { Hono } from 'hono';
import type { AppEnv } from './types';
import { authMiddleware } from './middleware';
import { handleSession, handleLogout, isDevBypassActive } from './api/session';
import { handleSendOtp } from './api/send-otp';
import { handleVerifyOtp } from './api/verify-otp';
import { handleDevMembers, handleDevLogin } from './api/dev-login';
import { handleBookings, handleBookingById, handleBookingCancel } from './api/bookings';
import { handleMembers, handleMemberById, handleMemberDependencies, handleMemberPayments } from './api/members';
import { handleAdminBookings, handleAdminBookingById } from './api/reg/admin-bookings';
import { handleAdminGuests, handleAdminGuestById } from './api/reg/admin-guests';
import { handleAdminExport } from './api/reg/admin-export';
import { handleAdminGuestList } from './api/reg/admin-guest-list';
import { handleVolunteerSearch, handleVolunteerArrive, handleVolunteerWalkin, handleVolunteerUpdateGuest } from './api/reg/volunteer-search';
import { handleRegDashboard } from './api/reg/reg-dashboard';
import { handleBuyerForm, handleBuyerUpdateGuest } from './api/reg/buyer-form';
import { handleSendMagicLink } from './api/reg/admin-magic-link';
import { handleRegTables } from './api/reg/reg-tables';
import { handleAdminSettingsGet, handleAdminSettingsPost } from './api/admin-settings';
import { handleVolunteerConfig, handleVolunteerRegister, handleVolunteerSubmissions, handleVolunteerExport } from './api/volunteer-reg';
import { handleLaughterYogaConfig, handleLaughterYogaRegister, handleLaughterYogaSubmissions, handleLaughterYogaExport } from './api/laughter-yoga-reg';
import {
  handleMembershipConfig,
  handleMembershipRegister,
  handleMembershipSubmissions,
  handleMembershipExport,
  handleMembershipImage,
  handleMembershipApprove,
  handleMembershipReject,
} from './api/membership-reg';
// ── DISABLED 2026-08: public namecard surface hidden (security audit).
// Restore by uncommenting + renaming _namecards.astro back. ──
// import {
//   handleNamecardPage,
//   handleNamecardVcard,
//   handleNamecardCardSvg,
//   handlePublicNamecardPhoto,
// } from './api/namecard-public';
import {
  handleNamecards,
  handleNamecardsBulk,
  handleNamecardById,
  handleNamecardSlug,
  handleNamecardPhoto,
  handleNamecardToggle,
  handleNamecardMe,
} from './api/namecards';

const app = new Hono<AppEnv>();

app.use('/api/*', authMiddleware);

// ── DISABLED 2026-08: public namecard surface hidden (security audit).
// The /c/:slug pages exposed member email, mobile and home address
// unauthenticated with guessable slugs. Hidden, not deleted — restore by
// uncommenting this block + the import above, renaming _namecards.astro back
// to namecards.astro, and re-adding '/c/*' to run_worker_first in
// wrangler.jsonc. ──
// app.get('/c/:slug', handleNamecardPage);
// app.get('/c/:slug/contact.vcf', handleNamecardVcard);
// app.get('/c/:slug/card.svg', handleNamecardCardSvg);
// app.get('/c/:slug/photo', handlePublicNamecardPhoto);

app.get('/api/health', (c) => {
  return c.json({ status: 'ok', service: 'swa-portal', timestamp: new Date().toISOString() });
});

app.get('/api/turnstile-config', (c) => {
  // In local dev (DEV_BYPASS_AUTH active), return an empty siteKey so the
  // client never loads the Turnstile widget — the sitekey in wrangler.jsonc
  // is authorised for production hostnames only and would fail with
  // Turnstile error 110200 on localhost. Server-side siteverify is also
  // skipped in dev (see the per-handler guards). Production is unaffected.
  if (isDevBypassActive(c.env, c.req.url)) {
    return c.json({ siteKey: '' });
  }
  const siteKey = c.env.TURNSTILE_SITE_KEY || '';
  return c.json({ siteKey });
});

// Auth
app.get('/api/session', handleSession);
app.delete('/api/session', handleLogout);
app.post('/api/send-otp', handleSendOtp);
app.post('/api/verify-otp', handleVerifyOtp);

// Dev-only role-picker login (local + *.workers.dev only — handlers 404 in prod)
app.get('/api/dev/members', handleDevMembers);
app.post('/api/dev/login', handleDevLogin);

// Office Bookings
app.get('/api/bookings', handleBookings);
app.post('/api/bookings', handleBookings);
app.get('/api/bookings/:id', handleBookingById);
app.patch('/api/bookings/:id/cancel', handleBookingCancel);

// Members
app.get('/api/members', handleMembers);
app.post('/api/members', handleMembers);
app.get('/api/members/:id', handleMemberById);
app.patch('/api/members/:id', handleMemberById);
app.delete('/api/members/:id', handleMemberById);
app.get('/api/members/:id/dependencies', handleMemberDependencies);
app.get('/api/members/:id/payments', handleMemberPayments);
app.post('/api/members/:id/payments', handleMemberPayments);

// Registration — Admin
app.get('/api/reg/admin/bookings', handleAdminBookings);
app.post('/api/reg/admin/bookings', handleAdminBookings);
app.get('/api/reg/admin/bookings/:id', handleAdminBookingById);
app.post('/api/reg/admin/guests', handleAdminGuests);
app.patch('/api/reg/admin/guests/:id', handleAdminGuestById);
app.delete('/api/reg/admin/guests/:id', handleAdminGuestById);
app.get('/api/reg/admin/export', handleAdminExport);
app.get('/api/reg/admin/guest-list', handleAdminGuestList);

// Registration — Volunteer
app.get('/api/reg/volunteer/search', handleVolunteerSearch);
app.post('/api/reg/volunteer/arrive/:id', handleVolunteerArrive);
app.post('/api/reg/volunteer/walkin', handleVolunteerWalkin);
app.post('/api/reg/volunteer/guest/:id', handleVolunteerUpdateGuest);

// Registration — Table config (any authenticated user)
app.get('/api/reg/tables', handleRegTables);

// Registration — Dashboard
app.get('/api/reg/dashboard/stats', handleRegDashboard);

// Registration — Buyer (token-gated, auth bypassed in middleware)
app.get('/api/reg/buyer/:token', handleBuyerForm);
app.patch('/api/reg/buyer/:token/guests/:id', handleBuyerUpdateGuest);

// Registration — Admin magic link
app.post('/api/reg/admin/send-magic-link/:bookingId', handleSendMagicLink);

// Admin Settings
app.get('/api/admin/settings', handleAdminSettingsGet);
app.post('/api/admin/settings', handleAdminSettingsPost);

// Volunteer Registration (public form at /reg/volunteer/register)
app.get('/api/volunteer/config', handleVolunteerConfig);
app.post('/api/volunteer/register', handleVolunteerRegister);

// Online Forms — admin + committee view submissions
app.get('/api/admin/forms/volunteer', handleVolunteerSubmissions);
app.get('/api/admin/forms/volunteer/export', handleVolunteerExport);

// Laughter Yoga Registration (public form at /reg/laughter-yoga/register)
app.get('/api/laughter-yoga/config', handleLaughterYogaConfig);
app.post('/api/laughter-yoga/register', handleLaughterYogaRegister);

// Online Forms — admin + committee view Laughter Yoga submissions
app.get('/api/admin/forms/laughter-yoga', handleLaughterYogaSubmissions);
app.get('/api/admin/forms/laughter-yoga/export', handleLaughterYogaExport);

// Membership Application (public form at /reg/membership/register)
app.get('/api/membership/config', handleMembershipConfig);
app.post('/api/membership/register', handleMembershipRegister);

// Online Forms — admin + committee view membership submissions
app.get('/api/admin/forms/membership', handleMembershipSubmissions);
app.get('/api/admin/forms/membership/export', handleMembershipExport);
app.get('/api/admin/forms/membership/image/:id/:kind', handleMembershipImage);

// Online Forms — admin only approve / reject (writes to members + memberships)
app.post('/api/admin/forms/membership/:id/approve', handleMembershipApprove);
app.post('/api/admin/forms/membership/:id/reject', handleMembershipReject);

// ── Namecards (admin CRUD + self-service) ──────────────────────────────────
//
// POST/PATCH/DELETE are admin-only via ADMIN_WRITE_API (middleware.ts).
// GET stays open to every authenticated role so committee/volunteer/advisor
// can use the self-service download panel. The /me route returns the caller's
// own row only.
app.get('/api/namecards', handleNamecards);
app.post('/api/namecards', handleNamecards);
app.post('/api/namecards/bulk', handleNamecardsBulk);
app.get('/api/namecards/me', handleNamecardMe);
app.get('/api/namecards/:id', handleNamecardById);
app.patch('/api/namecards/:id', handleNamecardById);
app.delete('/api/namecards/:id', handleNamecardById);
app.patch('/api/namecards/:id/slug', handleNamecardSlug);
app.patch('/api/namecards/:id/toggle', handleNamecardToggle);
app.post('/api/namecards/:id/photo', handleNamecardPhoto);
app.delete('/api/namecards/:id/photo', handleNamecardPhoto);

export default app;