// Dark mode for HTML email, Dark Reader-style: rather than inverting the whole page (which also
// flips photos and logos), remap colours by role. Light backgrounds/borders become dark and dark
// text becomes light, keeping hue so brand colours stay recognisable. Images are untouched.

type RGBA = [number, number, number, number];
type Role = 'bg' | 'fg';

let probe: HTMLElement | undefined;
const parsed = new Map<string, RGBA | null>();

/** Any CSS colour → RGBA, using the (rendered) popup document to resolve names etc. */
function parseColor(value: string): RGBA | null {
  const key = value.trim().toLowerCase();
  if (parsed.has(key)) return parsed.get(key)!;
  if (!probe) {
    probe = document.createElement('i');
    probe.style.display = 'none';
    document.body.append(probe);
  }
  probe.style.color = '';
  probe.style.color = key;
  let out: RGBA | null = null;
  if (probe.style.color) {
    const n = getComputedStyle(probe).color.match(/[\d.]+/g)?.map(Number) ?? [];
    if (n.length >= 3) out = [n[0]!, n[1]!, n[2]!, n[3] ?? 1];
  }
  parsed.set(key, out);
  return out;
}

function toHsl([r, g, b]: RGBA): [number, number, number] {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h / 6, s, l];
}

function fromHsl(h: number, s: number, l: number, a: number): string {
  const f = (n: number) => {
    const k = (n + h * 12) % 12;
    return Math.round(255 * (l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
  };
  return a < 1 ? `rgba(${f(0)}, ${f(8)}, ${f(4)}, ${a})` : `rgb(${f(0)}, ${f(8)}, ${f(4)})`;
}

/** Remapped colour, or null to leave it alone. Targets: page #1b1e20, text #d6d8da. */
function remap(value: string, role: Role): string | null {
  const c = parseColor(value);
  if (!c || c[3] === 0) return null;
  const [h, s, l] = toHsl(c);
  if (role === 'bg') {
    if (l < 0.45) return null; // already dark
    if (s > 0.5 && l < 0.7) return null; // saturated accent (buttons, banners): reads fine on dark
    return fromHsl(h, s * 0.75, 0.11 + (1 - l) * 0.55, c[3]);
  }
  if (l > 0.55) return null; // already light
  return fromHsl(h, Math.min(1, s * 1.05), 0.86 - l * 0.35, c[3]);
}

const COLOR_TOKEN =
  /url\([^)]*\)|#[0-9a-f]{3,8}\b|(?:rgb|hsl)a?\([^)]*\)|\b(?:white|black|silver|gr[ae]y|lightgr[ae]y|darkgr[ae]y|dimgr[ae]y|gainsboro|whitesmoke|snow|ivory|beige|linen|navy|blue|red|maroon|green|teal|purple|aliceblue|ghostwhite|floralwhite|azure|mintcream|honeydew|lavender|seashell|oldlace)\b/gi;

function remapValue(value: string, role: Role): string {
  return value.replace(COLOR_TOKEN, (tok) => (tok.startsWith('url(') ? tok : (remap(tok, role) ?? tok)));
}

const DECL = /(^|[;{\s])((?:background(?:-color)?)|color|border(?:-(?:top|right|bottom|left))?(?:-color)?|outline(?:-color)?)(\s*:\s*)([^;}]+)/gi;

/** Remap colours inside CSS text (style attributes or <style> blocks), by property. */
function remapCss(css: string): string {
  return css.replace(DECL, (_m, pre, prop: string, colon, value) => {
    const role: Role = prop.toLowerCase() === 'color' ? 'fg' : 'bg';
    return pre + prop + colon + remapValue(value, role);
  });
}

/** Rewrite an (inert, DOMParser) document's colours for a dark page. */
export function darkify(doc: Document) {
  for (const el of doc.querySelectorAll<HTMLElement>('[style]')) {
    el.setAttribute('style', remapCss(el.getAttribute('style')!));
  }
  for (const style of doc.querySelectorAll('style')) style.textContent = remapCss(style.textContent ?? '');
  // Legacy colour attributes can't take rgb(), so remapped values move into inline style
  // (unless inline style already sets that colour, which would win anyway).
  for (const el of doc.querySelectorAll<HTMLElement>('[bgcolor]')) {
    const v = remap(el.getAttribute('bgcolor')!, 'bg');
    if (!v) continue;
    el.removeAttribute('bgcolor');
    if (!el.style.backgroundColor && !el.style.background) el.style.backgroundColor = v;
  }
  for (const el of doc.querySelectorAll<HTMLElement>('font[color]')) {
    const v = remap(el.getAttribute('color')!, 'fg');
    if (!v) continue;
    el.removeAttribute('color');
    if (!el.style.color) el.style.color = v;
  }
}
