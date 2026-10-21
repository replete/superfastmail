// pnpm fake:chrome — try the fake-data build in Chrome by hand: Chrome for Testing (puppeteer's copy,
// so not your own Chrome), a fresh temporary profile with only the extension, signed in to the fake
// server by itself (FAKE_SETUP build). The fake server on 8765 is started here unless one is already
// running (e.g. pnpm fake:firefox's). Closing Chrome deletes the profile and stops the server.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { startFakeFastmail } from './fake-fastmail.mjs';

const PORT = 8765;
const EXT = path.resolve('.output-fake/chrome-mv3');

function chromeBinary() {
  if (process.env.CHROME_BIN) return process.env.CHROME_BIN;
  const root = path.join(os.homedir(), '.cache/puppeteer/chrome');
  const num = (d) => d.split('-').pop().split('.').map(Number);
  const newest = fs
    .readdirSync(root)
    .filter((d) => /\d+\.\d+/.test(d))
    .sort((a, b) => {
      const [x, y] = [num(a), num(b)];
      for (let i = 0; i < 4; i++) if (x[i] !== y[i]) return y[i] - x[i];
      return 0;
    });
  for (const d of newest) {
    for (const sub of fs.readdirSync(path.join(root, d))) {
      const mac = path.join(root, d, sub, 'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
      const linux = path.join(root, d, sub, 'chrome');
      for (const bin of [mac, linux]) if (fs.existsSync(bin)) return bin;
    }
  }
  throw new Error('No Chrome for Testing found: npx @puppeteer/browsers install chrome@stable (or set CHROME_BIN)');
}

const running = await new Promise((resolve) => {
  const s = net.connect(PORT, '127.0.0.1');
  s.on('connect', () => (s.end(), resolve(true)));
  s.on('error', () => resolve(false));
});
const fake = running ? undefined : await startFakeFastmail({ port: PORT });
console.log(running ? `fake server: using the one on ${PORT}` : `fake server: started on ${fake.url}`);

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'super-fastmail-chrome-'));
const chrome = spawn(
  chromeBinary(),
  // A mock keychain: a throwaway profile has no business in the macOS Keychain (it would ask for it).
  [`--user-data-dir=${profile}`, `--load-extension=${EXT}`, '--use-mock-keychain', '--password-store=basic', '--no-first-run', '--no-default-browser-check', 'chrome://extensions'],
  { stdio: 'ignore' },
);
console.log('Chrome for Testing: open (fresh profile, signed in to the fake server). Close it to finish.');

const done = async () => {
  fs.rmSync(profile, { recursive: true, force: true });
  await fake?.close();
  console.log('closed: profile deleted');
  process.exit(0);
};
chrome.on('exit', done);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => chrome.kill());
