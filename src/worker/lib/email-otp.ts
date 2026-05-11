export function buildOtpEmail(otp: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light only">
<meta name="supported-color-schemes" content="light only">
<title>Your SWA Portal Login Code</title>
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
            <p style="margin:6px 0 0;font-size:14px;color:rgba(255,255,255,0.7);font-family:'Montserrat',Arial,sans-serif;">Login Verification</p>
          </td>
        </tr>

        <tr>
          <td style="padding:24px;color:#1f2937;font-family:'Montserrat',Arial,sans-serif;">
            <p style="margin:0 0 16px;font-size:15px;color:#1f2937;">Hi,</p>
            <p style="margin:0 0 24px;font-size:14px;line-height:1.6;color:#6b7280;">
              Use the code below to log in to the SWA Admin Portal. This code expires in 10 minutes.
            </p>

            <table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" style="margin:0 auto 24px;">
              <tr><td bgcolor="#874ba1" style="background-color:#874ba1;padding:14px 32px;border-radius:6px;text-align:center;">
                <span style="font-family:'Courier New',monospace;font-size:28px;font-weight:700;letter-spacing:0.4em;color:#ffffff;">${otp}</span>
              </td></tr>
            </table>

            <p style="margin:0 0 20px;font-size:13px;line-height:1.6;color:#9ca3af;text-align:center;">
              If you did not request this code, you can safely ignore this email.
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