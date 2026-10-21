// Renders the logo to the PNG sizes the manifest and notifications use.
// Small sizes (16/32) use a simplified variant that stays legible; the toolbar button has its own.
//   node scripts/icons.mjs [outDir]
import { Resvg } from '@resvg/resvg-js';
import fs from 'node:fs';
import path from 'node:path';

const out = process.argv[2] ?? 'public/icon';
const full = fs.readFileSync('assets/logo.svg');
const small = fs.readFileSync('assets/logo-small.svg');
fs.mkdirSync(out, { recursive: true });
for (const size of [16, 32, 48, 96, 128]) {
  const png = new Resvg(size <= 32 ? small : full, { fitTo: { mode: 'width', value: size } }).render().asPng();
  fs.writeFileSync(path.join(out, `${size}.png`), png);
  console.log(`${out}/${size}.png`, png.length, 'bytes');
}
// Toolbar button: the envelope alone, and a red-tinted one for locked / not set up (the
// background swaps them).
for (const [name, file] of [['toolbar', 'assets/toolbar.svg'], ['toolbar-off', 'assets/toolbar-off.svg']]) {
  for (const size of [16, 32]) {
    const png = new Resvg(fs.readFileSync(file), { fitTo: { mode: 'width', value: size } }).render().asPng();
    fs.writeFileSync(path.join(out, `${name}-${size}.png`), png);
    console.log(`${out}/${name}-${size}.png`, png.length, 'bytes');
  }
}
fs.copyFileSync('assets/logo-mark.svg', 'public/logo-mark.svg');
