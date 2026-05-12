interface BookingDetails {
  booker_name: string;
  purpose: string;
  attendees: number;
  start_datetime: string;
  end_datetime: string;
  notes: string | null;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

export function buildBookingConfirmationEmail(booking: BookingDetails): string {
  const dateStr = formatDate(booking.start_datetime);
  const startTime = formatTime(booking.start_datetime);
  const endTime = formatTime(booking.end_datetime);
  const notesRow = booking.notes
    ? `<tr><td style="padding:8px 12px;color:#6b7280;font-size:14px;vertical-align:top;width:120px;">Notes</td><td style="padding:8px 12px;color:#1f2937;font-size:14px;">${booking.notes}</td></tr>`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light only">
<meta name="supported-color-schemes" content="light only">
<title>Booking Confirmed — SWA Office</title>
</head>
<body style="margin:0;padding:0;background-color:#f9fafb;color:#1f2937;font-family:'Montserrat',Arial,sans-serif;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" bgcolor="#f9fafb" style="background-color:#f9fafb;">
  <tr>
    <td align="center" style="padding:24px 12px;">
      <!--[if mso]>
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="480"><tr><td>
      <![endif]-->
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="480" bgcolor="#ffffff" style="width:480px;max-width:100%;background-color:#ffffff;border:1px solid #e5e7eb;border-radius:8px;">

        <tr>
          <td bgcolor="#450a5e" style="background-color:#450a5e;padding:24px;text-align:center;border-radius:8px 8px 0 0;">
            <h1 style="margin:0;font-size:22px;color:#ffffff;font-weight:700;font-family:'Montserrat',Arial,sans-serif;">SWA <span style="color:#f3d2ff;">Portal</span></h1>
            <p style="margin:6px 0 0;font-size:14px;color:rgba(255,255,255,0.7);font-family:'Montserrat',Arial,sans-serif;">Office Booking Confirmation</p>
          </td>
        </tr>

        <tr>
          <td style="padding:24px;color:#1f2937;font-family:'Montserrat',Arial,sans-serif;">
            <p style="margin:0 0 16px;font-size:15px;color:#1f2937;">Hi ${booking.booker_name},</p>
            <p style="margin:0 0 24px;font-size:14px;line-height:1.6;color:#6b7280;">
              Your office booking has been confirmed. Here are the details:
            </p>

            <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border:1px solid #e5e7eb;border-radius:6px;margin-bottom:24px;">
              <tr><td style="padding:8px 12px;color:#6b7280;font-size:14px;vertical-align:top;width:120px;border-bottom:1px solid #f3f4f6;">Date</td><td style="padding:8px 12px;color:#1f2937;font-size:14px;border-bottom:1px solid #f3f4f6;">${dateStr}</td></tr>
              <tr><td style="padding:8px 12px;color:#6b7280;font-size:14px;vertical-align:top;width:120px;border-bottom:1px solid #f3f4f6;">Time</td><td style="padding:8px 12px;color:#1f2937;font-size:14px;border-bottom:1px solid #f3f4f6;">${startTime} — ${endTime}</td></tr>
              <tr><td style="padding:8px 12px;color:#6b7280;font-size:14px;vertical-align:top;width:120px;border-bottom:1px solid #f3f4f6;">Purpose</td><td style="padding:8px 12px;color:#1f2937;font-size:14px;border-bottom:1px solid #f3f4f6;">${booking.purpose}</td></tr>
              <tr><td style="padding:8px 12px;color:#6b7280;font-size:14px;vertical-align:top;width:120px;border-bottom:1px solid #f3f4f6;">Attendees</td><td style="padding:8px 12px;color:#1f2937;font-size:14px;border-bottom:1px solid #f3f4f6;">${booking.attendees}</td></tr>
              ${notesRow}
            </table>

            <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:0 auto 24px;">
              <tr><td bgcolor="#874ba1" style="background-color:#874ba1;padding:12px 24px;border-radius:6px;text-align:center;">
                <a href="https://admin.singaporewomenassociation.org/office-booking" style="color:#ffffff;text-decoration:none;font-size:14px;font-weight:600;font-family:'Montserrat',Arial,sans-serif;">View Booking Calendar</a>
              </td></tr>
            </table>

            <p style="margin:0 0 20px;font-size:13px;line-height:1.6;color:#9ca3af;text-align:center;">
              If you need to cancel this booking, please visit the booking calendar above.
            </p>
          </td>
        </tr>

        <tr>
          <td style="padding:16px 24px;border-top:1px solid #e5e7eb;font-size:11px;color:#9ca3af;text-align:center;font-family:'Montserrat',Arial,sans-serif;">
            Singapore Women's Association<br>
            This is an automated message — please do not reply.
          </td>
        </tr>

      </table>
      <!--[if mso]>
      </td></tr></table>
      <![endif]-->
    </td>
  </tr>
</table>
</body>
</html>`;
}