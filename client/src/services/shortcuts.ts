/** Keyboard shortcuts: one table drives the handler and the "?" sheet. */
export type ShortcutAction =
  | 'write'
  | 'search'
  | 'archive'
  | 'snooze'
  | 'label'
  | 'reply'
  | 'replyAll'
  | 'forward'
  | 'next'
  | 'prev'
  | 'open'
  | 'star'
  | 'unread'
  | 'delete'
  | 'close'
  | 'undo'
  | 'help';

export interface ShortcutDef {
  action: ShortcutAction;
  /** Keys that trigger it (KeyboardEvent.key, letters compared in lower case). */
  keys: string[];
  /** What the key hint shows. */
  hint: string;
  label: string;
  group: 'Compose and find' | 'On a message' | 'Move around';
}

export const SHORTCUTS: ShortcutDef[] = [
  { action: 'write', keys: ['c'], hint: 'C', label: 'Write a new message', group: 'Compose and find' },
  { action: 'search', keys: ['/'], hint: '/', label: 'Search', group: 'Compose and find' },
  { action: 'help', keys: ['?'], hint: '?', label: 'Show this list', group: 'Compose and find' },
  { action: 'reply', keys: ['r'], hint: 'R', label: 'Reply', group: 'On a message' },
  { action: 'replyAll', keys: ['a'], hint: 'A', label: 'Reply all', group: 'On a message' },
  { action: 'forward', keys: ['f'], hint: 'F', label: 'Forward', group: 'On a message' },
  { action: 'archive', keys: ['e'], hint: 'E', label: 'Archive', group: 'On a message' },
  { action: 'snooze', keys: ['h'], hint: 'H', label: 'Snooze', group: 'On a message' },
  { action: 'label', keys: ['l'], hint: 'L', label: 'Label', group: 'On a message' },
  { action: 'star', keys: ['s'], hint: 'S', label: 'Star or unstar', group: 'On a message' },
  { action: 'unread', keys: ['u'], hint: 'U', label: 'Mark as unread', group: 'On a message' },
  { action: 'undo', keys: ['z'], hint: 'Z', label: 'Undo the last archive, delete or snooze', group: 'On a message' },
  { action: 'delete', keys: ['#', 'Delete'], hint: '#', label: 'Delete', group: 'On a message' },
  { action: 'next', keys: ['j', 'ArrowDown'], hint: 'J', label: 'Next message', group: 'Move around' },
  { action: 'prev', keys: ['k', 'ArrowUp'], hint: 'K', label: 'Previous message', group: 'Move around' },
  { action: 'open', keys: ['Enter'], hint: 'Enter', label: 'Open the selected message', group: 'Move around' },
  { action: 'close', keys: ['Escape'], hint: 'Esc', label: 'Close', group: 'Move around' }
];

export function hintFor(action: ShortcutAction): string {
  return SHORTCUTS.find((s) => s.action === action)?.hint ?? '';
}

/** True when the key press is going into something the person types in. */
export function isTypingTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') {
    const t = (el as HTMLInputElement).type;
    return !['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color', 'file'].includes(t);
  }
  return !!el.closest('[contenteditable="true"], .ProseMirror');
}

export interface ShortcutContext {
  /** A dialog, menu or the composer is open: only Escape and "?" work. */
  blocked?: boolean;
}

/**
 * Which action a key press means, or null. Never fires while typing, with Ctrl/Alt/Meta held,
 * or (for plain keys) when the focus is on a button that would take the key itself (Enter, Space).
 * Arrow keys and Enter on a message row are handled by the list itself, so they are skipped here
 * when the focus is inside the list.
 */
export function actionForKey(
  e: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'target' | 'defaultPrevented'>,
  ctx: ShortcutContext = {}
): ShortcutAction | null {
  if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return null;
  if (isTypingTarget(e.target)) return null;
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  const def = SHORTCUTS.find((s) => s.keys.some((k) => (k.length === 1 ? k : k) === key));
  if (!def) return null;
  if (ctx.blocked && def.action !== 'close' && def.action !== 'help') return null;
  if (def.action === 'open') {
    // Enter on a button or link does what that control does.
    const el = e.target as HTMLElement | null;
    if (el && el !== document.body && el.closest('button, a, [role="menuitem"], [role="tab"]')) return null;
  }
  if ((def.action === 'next' || def.action === 'prev') && (key === 'ArrowDown' || key === 'ArrowUp')) {
    // The list moves its own focus with the arrows.
    const el = e.target as HTMLElement | null;
    if (el && el.closest('[data-row-open], [role="menu"], [role="dialog"]')) return null;
  }
  return def.action;
}
