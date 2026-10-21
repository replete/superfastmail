// Small helpers shared by the popup's app views.
import { html, render, type Html } from '@/lib/html';
import { ICONS } from '@/lib/icons';

export const $ = (id: string) => document.getElementById(id)!;
export const NEEDS_WRITE = 'needs an API token with write access';

/** A labelled detail row (icon, small label, value) with a copy button on hover. */
export function detailRow(icon: keyof typeof ICONS, label: string, value: string, href?: string, copy = true): Html {
  const v = href ? html`<a href="${href}" target="_blank" rel="noreferrer">${value}</a>` : value;
  return html`<div class="crow-d"><span class="cico">${ICONS[icon]}</span>
    <span class="cval"><span class="clabel">${label}</span><span class="cv">${v}</span></span>
    ${copy && html`<button class="ccopy" data-copy="${value}" title="Copy">${ICONS.copy}</button>`}</div>`;
}

/** Make every `[data-copy]` button inside `root` copy its value, with a brief tick. */
export function wireCopy(root: HTMLElement) {
  root.addEventListener('click', async (e) => {
    const btn = (e.target as Element).closest<HTMLElement>('[data-copy]');
    if (!btn) return;
    await navigator.clipboard.writeText(btn.dataset.copy!);
    const before = [...btn.childNodes];
    render(btn, btn.classList.contains('ccopy') ? ICONS.check : html`${ICONS.check}Copied`);
    setTimeout(() => btn.replaceChildren(...before), 1200);
  });
}

export function shortDate(iso?: string) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });
}

/** 1.2 MB, 340 KB, 12 bytes. */
export function fmtSize(bytes: number) {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(bytes >= 1e10 ? 0 : 1)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  if (bytes >= 1e3) return `${Math.round(bytes / 1e3)} KB`;
  return `${bytes} bytes`;
}
