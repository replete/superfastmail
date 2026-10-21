import { darkify } from './email-dark';
import type { FullEmail } from './jmap';

// Email bodies are untrusted HTML shown inside a privileged extension page. Defence in depth:
//  1. parse inertly with DOMParser (no scripts run, nothing loads) and strip active/remote elements,
//  2. a CSP meta in the srcdoc: `default-src 'none'`, so no script can run (inline handlers
//     included) and nothing loads unless the user opts into remote images,
//  3. an <iframe sandbox> (allow-same-origin and allow-scripts, so the popup can size the frame and
//     listen in it; the email's own scripts are stopped by 1 and 2).
const STRIP =
  'script, noscript, iframe, frame, frameset, object, embed, applet, base, link, meta, form, input, button, select, textarea, ' +
  // SVG animation can rewrite attributes (e.g. a link's href) after sanitising.
  'animate, set, animateMotion, animateTransform, discard';

/** URL attributes and the schemes each may keep (checked after the browser's own normalisation). */
const URL_ATTRS: Record<string, RegExp> = {
  href: /^(https?:|mailto:|tel:|#)/i,
  'xlink:href': /^(https?:|mailto:|tel:|#)/i,
  src: /^(https?:|data:image\/|cid:)/i,
  background: /^(https?:|data:image\/|cid:)/i,
  poster: /^(https?:|data:image\/|cid:)/i,
};
/** Browsers ignore control characters and spaces in a URL's scheme ("java\tscript:"), so check without them. */
const squash = (v: string) => v.replace(/[\u0000-\u0020\u007f-\u009f]/g, '');

export interface Rendered {
  srcdoc: string;
  /** Number of remote resources blocked (images, CSS backgrounds). */
  remote: number;
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function linkify(escaped: string) {
  return escaped.replace(/https?:\/\/[^\s<>"']+/g, (u) => `<a href="${u}" rel="noopener noreferrer">${u}</a>`);
}

function sanitize(html: string, dark: boolean): { body: string; remote: number } {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll(STRIP).forEach((el) => el.remove());
  if (dark) darkify(doc);
  for (const el of doc.querySelectorAll('*')) {
    for (const attr of [...el.attributes]) {
      const name = attr.name.toLowerCase();
      const allowed = URL_ATTRS[name];
      if (name.startsWith('on')) el.removeAttribute(attr.name);
      // URL attributes keep only safe schemes (no javascript:, data:text/html, relative links…).
      else if (allowed && !allowed.test(squash(attr.value))) el.removeAttribute(attr.name);
      else if (/^\s*javascript:/i.test(squash(attr.value))) el.removeAttribute(attr.name);
    }
  }
  // Links always open in a new tab (never inside the frame, whatever target they ask for), with no
  // way back to this frame (it shares the extension's origin).
  for (const a of doc.querySelectorAll('a, area')) {
    a.setAttribute('target', '_blank');
    a.setAttribute('rel', 'noopener noreferrer');
  }
  const remote =
    doc.querySelectorAll('img[src^="http"], img[srcset], [background^="http"]').length +
    (html.match(/url\(\s*['"]?https?:/gi)?.length ?? 0);
  const styles = [...doc.head.querySelectorAll('style')].map((s) => s.outerHTML).join('');
  return { body: styles + doc.body.innerHTML, remote };
}

/**
 * `dark` themes the message: plain text directly, HTML by remapping its colours (see email-dark.ts).
 * `original` keeps HTML mail's own colours on a white page.
 */
export function renderEmail(email: FullEmail, allowRemote: boolean, dark = false, original = false): Rendered {
  const darkPage = dark && !(email.html && original);
  const csp = allowRemote
    ? "default-src 'none'; img-src https: http: data:; style-src 'unsafe-inline' https:; font-src https: data:"
    : "default-src 'none'; img-src data:; style-src 'unsafe-inline'";
  const { body, remote } = email.html
    ? sanitize(email.html, darkPage)
    : { body: `<pre>${linkify(escapeHtml(email.text ?? ''))}</pre>`, remote: 0 };
  const srcdoc = `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<base target="_blank">
<style>
  /* Sized to its content by the popup: no inner scrolling, no layouts that fill the frame. */
  html { overflow-y: hidden; overflow-x: auto; }
  html, body { height: auto !important; min-height: 0 !important; }
  html { background: ${darkPage ? '#1b1e20' : '#fff'}; color: ${darkPage ? '#d6d8da' : '#1b1e20'}; }
  a { color: ${darkPage ? '#6ca8d2' : '#306bad'}; }
  /* Lined up with the header: HTML with the avatar, plain text with the sender's name. */
  body { margin: ${email.html ? '4px 14px 14px' : '2px 14px 14px 66px'}; font: 14px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; overflow-wrap: anywhere; }
  img { max-width: 100%; height: auto; }
  pre { white-space: pre-wrap; font: inherit; margin: 0; }
  table { max-width: 100%; }
</style></head><body>${body}</body></html>`;
  return { srcdoc, remote };
}

// Quoted and pasted mail goes into the compose editor, which is part of the extension page itself
// (not a sandboxed frame), so it's held to an allowlist: basic formatting tags, no styles, ids or
// classes (they'd restyle or cover the popup), safe links only, and no remote images (tracking).
const EDIT_TAGS = new Set(
  'P BR DIV SPAN B STRONG I EM U S STRIKE A UL OL LI BLOCKQUOTE PRE CODE H1 H2 H3 H4 H5 H6 TABLE THEAD TBODY TR TD TH IMG HR SUB SUP'.split(' '),
);
const EDIT_ATTRS: Record<string, string[]> = { A: ['href'], IMG: ['src', 'alt'], TD: ['colspan', 'rowspan'], TH: ['colspan', 'rowspan'], BLOCKQUOTE: ['type'] };

export function sanitizeForEditor(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll(`${STRIP}, style, title`).forEach((el) => el.remove());
  const walk = (el: Element) => {
    for (const child of [...el.children]) {
      walk(child);
      if (!EDIT_TAGS.has(child.tagName)) {
        child.replaceWith(...child.childNodes); // unknown (incl. SVG): keep the text, drop the element
        continue;
      }
      for (const attr of [...child.attributes]) {
        const name = attr.name.toLowerCase();
        const kept = EDIT_ATTRS[child.tagName]?.includes(name) && (!URL_ATTRS[name] || URL_ATTRS[name]!.test(squash(attr.value)));
        if (!kept) child.removeAttribute(attr.name);
      }
      if (child.tagName === 'IMG' && !/^data:image\//i.test(squash(child.getAttribute('src') ?? ''))) child.remove();
      if (child.tagName === 'A') {
        child.setAttribute('target', '_blank');
        child.setAttribute('rel', 'noopener noreferrer');
      }
    }
  };
  walk(doc.body);
  return doc.body.innerHTML;
}

export { escapeHtml };
