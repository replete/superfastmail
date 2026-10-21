/** Dev fixtures hooks are compiled in only for FIXTURES=1 builds. */
declare const __FIXTURES__: boolean;
/** JMAP session URL: api.fastmail.com, or the fake server in FAKE_FASTMAIL builds. */
declare const __SESSION_URL__: string;
/** FAKE_FASTMAIL builds (made-up mail from scripts/fake-fastmail.mjs): marked in the UI. */
declare const __FAKE__: boolean;
/** CalDAV server and Files (WebDAV) root: Fastmail's, or the fake server's in FAKE_FASTMAIL builds. */
declare const __CALDAV_URL__: string;
declare const __FILES_URL__: string;
/** Fake builds that sign themselves in on install (pnpm fake:chrome). */
declare const __FAKE_SETUP__: boolean;
