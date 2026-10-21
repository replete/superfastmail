// Markup for the extension's pages. Templates are written with the `html` tag, which escapes every value it
// interpolates unless it's already Html (another html`` template, an icon, or sanitised email HTML marked with
// `raw`). render() and insert() are the only places that turn markup into nodes, so anything reaching the DOM
// went through html``. Html has no toString on purpose: a template that's concatenated or joined by mistake
// shows up as "[object Object]" instead of quietly working.
export class Html {
  constructor(readonly value: string) {}
}

type Value = Html | string | number | boolean | null | undefined | readonly Value[];

export const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** Trusted markup: our own constants, or HTML that has already been sanitised. Say why at each use. */
export const raw = (s: string) => new Html(s);

const part = (v: Value): string =>
  v instanceof Html ? v.value : Array.isArray(v) ? v.map(part).join('') : v == null || v === false ? '' : esc(String(v));

export function html(strings: TemplateStringsArray, ...values: Value[]) {
  return new Html(strings.reduce((out, s, i) => out + s + (i < values.length ? part(values[i]) : ''), ''));
}

// Parsed in an inert document (nothing in it runs or loads) and the nodes moved in. Parsing is in <body> context,
// so a template can't start with a table part (<tr>, <td>…) on its own; none do.
const nodes = (h: Html) => [...new DOMParser().parseFromString(h.value, 'text/html').body.childNodes];

export function render(el: Element, h: Html) {
  el.replaceChildren(...nodes(h));
}

export function insert(el: Element, where: InsertPosition, h: Html) {
  ({ beforebegin: el.before, afterbegin: el.prepend, beforeend: el.append, afterend: el.after })[where].apply(el, nodes(h));
}
