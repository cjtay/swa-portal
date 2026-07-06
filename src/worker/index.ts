import { Hono } from 'hono';
import type { Env } from './types';
import { authMiddleware } from './middleware';
import { handleSession, handleLogout } from './api/session';
import { handleSendOtp } from './api/send-otp';
import { handleVerifyOtp } from './api/verify-otp';
import { handleBookings, handleBookingById, handleBookingCancel } from './api/bookings';
import { handleMembers, handleMemberById, handleMemberPhoto, handleMemberDependencies } from './api/members';
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
import {
  handleMembershipConfig,
  handleMembershipRegister,
  handleMembershipSubmissions,
  handleMembershipExport,
  handleMembershipImage,
  handleMembershipApprove,
  handleMembershipReject,
} from './api/membership-reg';

const app = new Hono<{
  Bindings: Env;
  Variables: { sessionEmail: string; sessionName: string; sessionRole: string; sessionRegRole: string | null };
}>();

app.use('/api/*', authMiddleware);

app.get('/api/health', (c) => {
  return c.json({ status: 'ok', service: 'swa-portal', timestamp: new Date().toISOString() });
});

app.get('/api/turnstile-config', (c) => {
  const siteKey = c.env.TURNSTILE_SITE_KEY || '';
  return c.json({ siteKey });
});

// Auth
app.get('/api/session', handleSession);
app.delete('/api/session', handleLogout);
app.post('/api/send-otp', handleSendOtp);
app.post('/api/verify-otp', handleVerifyOtp);

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
app.post('/api/members/:id/photo', handleMemberPhoto);
app.get('/api/members/:id/dependencies', handleMemberDependencies);

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

export default app;