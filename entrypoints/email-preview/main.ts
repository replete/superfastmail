// Dev-only (FIXTURES=1): renders a made-up newsletter through the real email renderer,
// original vs dark, so dark-mode colour remapping can be checked without real mail.
import { renderEmail } from '@/lib/email-view';
import type { FullEmail } from '@/lib/jmap';

const logo =
  'data:image/svg+xml,' +
  encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="120" height="32"><rect width="120" height="32" rx="6" fill="#ff6600"/><text x="60" y="21" font-family="sans-serif" font-size="14" fill="#fff" text-anchor="middle">ACME</text></svg>');

const html = `
<html><head><style>
  .note { background-color: #f5f5f5; color: #555555; border: 1px solid #dddddd; padding: 12px; }
  a { color: #1a73e8; }
</style></head>
<body bgcolor="#ffffff">
<table width="100%" bgcolor="#eef2f7" cellpadding="16"><tr><td>
  <table width="100%" bgcolor="#ffffff" style="border-radius:8px">
    <tr><td style="background:#1a73e8;color:#ffffff;padding:16px;font-size:20px"><img src="${logo}" alt="ACME"> Weekly update</td></tr>
    <tr><td style="color:#333333;padding:16px">
      <p>Hi there,</p>
      <p>Here is what happened this week. <a href="https://example.com">Read the full post</a>.</p>
      <div class="note">A light grey callout box with muted text.</div>
      <p><font color="#000080">Navy font tag text.</font></p>
      <p><a href="https://example.com" style="display:inline-block;background-color:#ff6600;color:#ffffff;padding:10px 16px;border-radius:4px;text-decoration:none">Call to action</a></p>
    </td></tr>
    <tr><td style="background-color:#fafafa;color:#999999;font-size:12px;padding:16px">You get this email because you signed up. Unsubscribe.</td></tr>
  </table>
</td></tr></table>
</body></html>`;

const email: FullEmail = {
  id: 'x', threadId: 't', subject: 'Weekly update', receivedAt: new Date().toISOString(),
  from: [{ name: 'ACME', email: 'news@example.com' }], to: [], cc: [], mailboxIds: {}, html,
};
(document.getElementById('light') as HTMLIFrameElement).srcdoc = renderEmail(email, false, false).srcdoc;
(document.getElementById('dark') as HTMLIFrameElement).srcdoc = renderEmail(email, false, true).srcdoc;
