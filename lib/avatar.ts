// Fastmail-style sender avatars: initials on a muted colour picked from the sender's name, with
// a matching tint for the name. Green pair sampled from Fastmail's dark theme; others extrapolated.
const PALETTE: { bg: string; name: string }[] = [
  { bg: '#1f4d3f', name: '#a7d8c9' }, // green (sampled)
  { bg: '#1e3f62', name: '#a9c8ec' }, // blue
  { bg: '#3e2f63', name: '#c7b8ef' }, // purple
  { bg: '#632f36', name: '#efb5bd' }, // red
  { bg: '#5c4716', name: '#ecd29a' }, // amber
  { bg: '#1d4f57', name: '#a3dbe3' }, // teal
];

export function avatarFor(name: string) {
  let h = 0;
  for (const c of name.toLowerCase()) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const words = name.replace(/[^\p{L}\p{N} ]/gu, ' ').trim().split(/\s+/).filter(Boolean);
  const initials = ((words[0]?.[0] ?? '?') + (words.length > 1 ? words.at(-1)![0] : '')).toUpperCase();
  return { initials, ...PALETTE[h % PALETTE.length]! };
}
