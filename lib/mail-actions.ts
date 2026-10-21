// What each mail action changes on the server, and how to put it back. Pure: the popup does the
// requests and the UI.
import type { EmailFlags, MailboxRole } from './jmap';

export type MailAction = 'archive' | 'delete' | 'spam' | 'notspam' | 'restore' | 'move' | 'read' | 'unread' | 'pin' | 'unpin';

/** Actions that take the message out of the list it's in. */
export const MOVES: ReadonlySet<MailAction> = new Set(['archive', 'delete', 'spam', 'notspam', 'restore', 'move']);

/** What the undo toast says. */
export const DONE: Record<MailAction, string> = {
  archive: 'Archived',
  delete: 'Moved to Trash',
  spam: 'Reported as spam',
  notspam: 'Moved to Inbox (not spam)',
  restore: 'Restored to Inbox',
  move: 'Moved',
  read: 'Marked as read',
  unread: 'Marked as unread',
  pin: 'Pinned',
  unpin: 'Unpinned',
};

/**
 * The JMAP patch for one message, viewed in mailbox `from` (default: Inbox). Archive takes it out of
 * that mailbox and keeps other labels; Trash and Spam replace them; Not spam / Restore go to Inbox.
 */
export function patchFor(
  action: MailAction,
  roles: Partial<Record<MailboxRole, string>>,
  now: EmailFlags,
  from = roles.inbox,
  target?: string,
): Record<string, unknown> {
  switch (action) {
    case 'move': {
      if (!target) throw new Error('No folder chosen');
      const patch: Record<string, unknown> = { [`mailboxIds/${target}`]: true };
      if (from && from !== target && now.mailboxIds[from]) patch[`mailboxIds/${from}`] = null;
      return patch;
    }
    case 'archive': {
      const patch: Record<string, unknown> = {};
      if (from && now.mailboxIds[from] && from !== roles.archive) patch[`mailboxIds/${from}`] = null;
      if (roles.archive) patch[`mailboxIds/${roles.archive}`] = true;
      return patch;
    }
    case 'notspam':
      if (!roles.inbox) throw new Error('No Inbox');
      return { mailboxIds: { [roles.inbox]: true }, 'keywords/$junk': null, 'keywords/$notjunk': true };
    case 'restore':
      if (!roles.inbox) throw new Error('No Inbox');
      return { mailboxIds: { [roles.inbox]: true } };
    case 'delete':
      if (!roles.trash) throw new Error('No Trash folder');
      return { mailboxIds: { [roles.trash]: true } };
    case 'spam':
      if (!roles.junk) throw new Error('No Spam folder');
      return { mailboxIds: { [roles.junk]: true }, 'keywords/$junk': true, 'keywords/$notjunk': null };
    case 'read':
      return { 'keywords/$seen': true };
    case 'unread':
      return { 'keywords/$seen': null };
    case 'pin':
      return { 'keywords/$flagged': true };
    case 'unpin':
      return { 'keywords/$flagged': null };
  }
}

/** Put a message back exactly as it was. */
export const undoPatch = (before: EmailFlags) => ({ mailboxIds: before.mailboxIds, keywords: before.keywords });
