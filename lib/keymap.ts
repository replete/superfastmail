// Defaults follow Fastmail's web shortcuts (fastmail.help "Keyboard shortcuts"), so muscle memory
// carries over. Kept in one table so they can be made user-configurable later.
export type Action =
  | 'next'
  | 'prev'
  | 'open'
  | 'back'
  | 'refresh'
  | 'loadImages'
  | 'select'
  | 'search'
  | 'compose'
  | 'archive'
  | 'delete'
  | 'spam'
  | 'markRead'
  | 'markUnread'
  | 'pin'
  | 'undo'
  | 'archiveNext'
  | 'archivePrev'
  | 'nextMessage'
  | 'prevMessage'
  | 'reply'
  | 'replyAll'
  | 'forward'
  | 'folders'
  | 'move';

export const DEFAULT_KEYS: Record<Action, string[]> = {
  next: ['j'], // next conversation down (older)
  prev: ['k'], // previous conversation (newer)
  open: ['o', 'Enter'],
  back: ['u', 'Escape'], // reader → list
  refresh: ['u'], // in the list
  loadImages: ['Shift+l'], // "Display blocked images"
  select: ['x'], // select / deselect conversation
  search: ['/'],
  compose: ['c'],
  // Conversation actions (need a token with write access).
  archive: ['y'],
  delete: ['d', '#'], // "Delete to Trash"
  spam: ['!'],
  markRead: ['Shift+i'],
  markUnread: ['Shift+u'],
  pin: ['s'], // "Toggle pinned"
  undo: ['z'],
  archiveNext: ['['], // reading: archive, then the next (older) message
  archivePrev: [']'],
  // In a conversation: the next / previous message ("Focus next / previous").
  nextMessage: ['n'],
  prevMessage: ['p'],
  // Reading: write a reply (needs a token that can send).
  reply: ['r'],
  replyAll: ['a'],
  forward: ['f'],
  folders: ['g'], // "Go to folder"
  move: ['m', 'v'],
};

/** What each shortcut does, for the settings page's list (same order as Fastmail's help). */
export const KEY_HELP: [Action, string][] = [
  ['compose', 'Compose'],
  ['reply', 'Reply'],
  ['replyAll', 'Reply all'],
  ['forward', 'Forward'],
  ['search', 'Search'],
  ['folders', 'Go to folder'],
  ['refresh', 'Refresh'],
  ['next', 'Next conversation'],
  ['prev', 'Previous conversation'],
  ['open', 'Open'],
  ['back', 'Back'],
  ['nextMessage', 'Next message'],
  ['prevMessage', 'Previous message'],
  ['select', 'Select or deselect'],
  ['pin', 'Pin or unpin'],
  ['archive', 'Archive'],
  ['archiveNext', 'Archive, then next'],
  ['archivePrev', 'Archive, then previous'],
  ['move', 'Move to folder'],
  ['delete', 'Delete'],
  ['spam', 'Report spam'],
  ['markRead', 'Mark read'],
  ['markUnread', 'Mark unread'],
  ['undo', 'Undo'],
  ['loadImages', 'Show images'],
];

/** "Shift+i" → "Shift+I", "Escape" → "Esc", for display. */
export const keyLabel = (k: string) => k.replace(/Shift\+([a-z])$/, (_, c) => `Shift+${c.toUpperCase()}`).replace('Escape', 'Esc');

/** Normalise a key event to e.g. "j", "Shift+l", "Ctrl+Enter", "!". */
export function combo(e: KeyboardEvent): string {
  const parts: string[] = [];
  if (e.ctrlKey) parts.push('Ctrl');
  if (e.altKey) parts.push('Alt');
  if (e.metaKey) parts.push('Meta');
  const letter = e.key.length === 1 && /[a-z]/i.test(e.key);
  if (e.shiftKey && (letter || e.key.length > 1)) parts.push('Shift');
  parts.push(letter ? e.key.toLowerCase() : e.key);
  return parts.join('+');
}

export function matches(e: KeyboardEvent, action: Action, keys = DEFAULT_KEYS): boolean {
  return keys[action].includes(combo(e));
}
