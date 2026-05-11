import { Hono } from 'hono';
import type { Env } from './types';
import { authMiddleware } from './middleware';
import { handleSession } from './api/session';
import { handleSendOtp } from './api/send-otp';
import { handleVerifyOtp } from './api/verify-otp';
import { handleBookings, handleBookingById, handleBookingStatus } from './api/bookings';
import { handleMembers, handleMemberById, handleMemberPhoto } from './api/members';

const app = new Hono<{
  Bindings: Env;
  Variables: { sessionEmail: string; sessionName: string; sessionRole: string };
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
app.post('/api/send-otp', handleSendOtp);
app.post('/api/verify-otp', handleVerifyOtp);

// Bookings
app.get('/api/bookings', handleBookings);
app.post('/api/bookings', handleBookings);
app.get('/api/bookings/:id', handleBookingById);
app.patch('/api/bookings/:id/status', handleBookingStatus);

// Members
app.get('/api/members', handleMembers);
app.post('/api/members', handleMembers);
app.get('/api/members/:id', handleMemberById);
app.patch('/api/members/:id', handleMemberById);
app.delete('/api/members/:id', handleMemberById);
app.post('/api/members/:id/photo', handleMemberPhoto);

export default app;