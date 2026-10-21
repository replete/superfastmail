# Store listing

What's entered on addons.mozilla.org (AMO), kept here so the next submission and the Chrome Web Store listing start from it.

## Summary

250 characters at most. Shown in listings and search results.

> Read, reply and triage Fastmail mail from your toolbar, with desktop push notifications (with audio), unread count, editable calendar, files, contacts and masked email. Connects with your own Fastmail API token and DAV password. Unofficial.

## Description

Shown only on the add-on's page. AMO's Markdown supports bold, italic, links, lists, blockquotes and code, but not headings. The first 250 characters should stand on their own.

```markdown
Fastmail in your toolbar. Read, search and reply to mail, get desktop notifications and an unread count, and check your calendar, files, contacts and masked email, all from one dropdown, without keeping a Fastmail tab open.

**Mail**

- Inbox, Unread, Pinned, VIPs and All tabs, with search as you type
- Full conversations with attachments and embedded images. Remote images stay off until you allow them
- Archive, delete, spam, pin, mark read and move, one at a time or in bulk. Every action can be undone, and Fastmail's keyboard shortcuts work
- Compose, reply and forward with your identities, signatures, contact suggestions, formatting and attachments
- Undo send and schedule send
- Desktop notifications with 17 sounds, Do Not Disturb and live push updates

**Calendar**

- Agenda, week and month views
- Create, edit, move and delete events, with reminders as notifications

**Files**

- Browse, preview, upload, download, rename, move and delete

**And also**

- Contacts, Masked Email (create, enable, disable) and your vacation response
- Light and dark themes, compact lists and a pop-out window

**Setting up**

1. In Fastmail, create an API token under Settings → Privacy & Security → Integrations. Read-only is enough for reading mail; tick more scopes to unlock more features.
2. Paste it in the extension under Settings → Connection & security.
3. For Calendar and Files, also add a Fastmail app password with DAV access.

**Privacy**

Your token stays in your browser, and the extension only talks to Fastmail: no analytics, no other servers. You can lock your credentials with a password, passkey or security key. Emails are cleaned before they're shown, and displayed in a frame that blocks scripts and remote content.

Super Fastmail is an independent project, not affiliated with or endorsed by Fastmail.
```

## Notes to reviewer

Only reviewers see these.

```text
SOURCE AND BUILD
The add-on is bundled and minified with WXT (Vite). The uploaded sources zip is the repository at the v1.0.0 tag: https://github.com/replete/superfastmail (release: https://github.com/replete/superfastmail/releases/tag/v1.0.0, built by GitHub Actions from that tag).
Requirements: Node 24, pnpm 10 (corepack enable).
  pnpm install --frozen-lockfile
  pnpm exec wxt zip -b firefox --mv3
Output: .output/firefox-mv3 and .output/super-fastmail-1.0.0-firefox.zip.

TESTING
It needs a Fastmail account. In Fastmail: Settings > Privacy & Security > Integrations > New API token, then paste it in the extension under Settings > Connection & security. Calendar and Files also need an app password with DAV access. Without an account, `pnpm fake:firefox` runs a separate build against a local fake Fastmail server (scripts/fake-fastmail.mjs) with sample mail, calendars, files and contacts. That build adds an http://127.0.0.1 host permission and is not the submitted one.

LINTER WARNINGS
The three innerHTML warnings are all in vendor/event-calendar.min.js, which is @event-calendar/build 5.17.2, unmodified. They are its own template cloning and the branch that renders content passed as { html: "..." }. We don't set eventContent and pass event titles as plain strings, so that branch never runs. Our own code has no innerHTML: markup is built with an escaping html`` template tag and parsed with DOMParser (lib/html.ts).

PERMISSIONS
- api.fastmail.com, *.fastmail.com: JMAP (mail, contacts, masked email), CalDAV and WebDAV on the user's own account. Nothing else is contacted.
- storage: settings and the encrypted credentials.
- alarms: polling fallback and calendar reminders.
- notifications: new mail and event reminders.
- contextMenus: the toolbar button's right-click menu (Open Fastmail, Refresh, Do Not Disturb, Options).
- activeTab: to suggest the current site's domain when creating a masked email address.
- data_collection_permissions personalCommunications: mail is only exchanged with the user's own Fastmail account, but it's declared because it's handled outside the browser.

Email HTML is sanitised and shown in a sandboxed iframe with a default-src 'none' CSP. The test suite includes a hostile email.
```
