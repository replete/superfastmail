// Checks the token in .env against the live API. Prints permissions and counts only:
// no addresses, names, subjects or message content.
//
//   pnpm probe
const token = process.env.FASTMAIL_API_KEY;
if (!token) throw new Error('FASTMAIL_API_KEY not set (run via `pnpm probe`)');

const h = { Authorization: `Bearer ${token}` };
const res = await fetch('https://api.fastmail.com/jmap/session', { headers: h });
if (!res.ok) throw new Error(`session: HTTP ${res.status}`);
const s = await res.json();

console.log('apiUrl:', s.apiUrl);
console.log('eventSourceUrl present:', Boolean(s.eventSourceUrl));
console.log('session capabilities:', Object.keys(s.capabilities).join(', '));
for (const [id, acct] of Object.entries(s.accounts)) {
  const primaryFor = Object.entries(s.primaryAccounts)
    .filter(([, a]) => a === id)
    .map(([cap]) => cap.split(':').pop());
  console.log(`account ${id}: isReadOnly=${acct.isReadOnly} isPersonal=${acct.isPersonal}`);
  console.log(`  capabilities: ${Object.keys(acct.accountCapabilities).join(', ')}`);
  console.log(`  primary for: ${primaryFor.join(', ') || '-'}`);
}

const accountId = s.primaryAccounts['urn:ietf:params:jmap:mail'];
const r = await (
  await fetch(s.apiUrl, {
    method: 'POST',
    headers: { ...h, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      using: ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail'],
      methodCalls: [['Mailbox/get', { accountId, properties: ['role', 'unreadEmails'] }, '0']],
    }),
  })
).json();
const boxes = r.methodResponses[0][1].list;
console.log('mailboxes:', boxes.length, '| inbox unread:', boxes.find((m) => m.role === 'inbox')?.unreadEmails);
