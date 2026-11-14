/** Rules for swiping a message row on a phone. Kept apart from the touch handling so they can be tested. */
export const ROW_EDGE_PX = 20; // the left edge belongs to the system back gesture
export const ROW_INTENT_PX = 10;
export const ROW_MIN_COMMIT_PX = 88;
export const ROW_COMMIT_FRACTION = 0.3;
export const ROW_MAX_FRACTION = 0.6;

export type RowSwipeAction = 'archive' | 'read';

/** Is the first movement clearly sideways, clearly vertical, or not decided yet? */
export function swipeIntent(dx: number, dy: number): 'horizontal' | 'vertical' | 'undecided' {
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  if (ax < ROW_INTENT_PX && ay < ROW_INTENT_PX) return 'undecided';
  if (ax > ROW_INTENT_PX && ax > ay * 1.5) return 'horizontal';
  if (ay > ROW_INTENT_PX) return 'vertical';
  return 'undecided';
}

export function startsInEdge(clientX: number): boolean {
  return clientX < ROW_EDGE_PX;
}

/** Distance past which letting go commits the action. */
export function commitDistance(width: number): number {
  return Math.max(ROW_MIN_COMMIT_PX, width * ROW_COMMIT_FRACTION);
}

/** Left = archive (when the folder allows it), right = mark read or unread. */
export function actionFor(dx: number, canArchive: boolean): RowSwipeAction | null {
  if (dx < 0) return canArchive ? 'archive' : null;
  if (dx > 0) return 'read';
  return null;
}

/** How far the row follows the finger: freely to the commit point, then with resistance; a refused side barely moves. */
export function swipeTravel(dx: number, width: number, canArchive: boolean): number {
  if (dx < 0 && !canArchive) return Math.max(dx, -24) * 0.5;
  const limit = width * ROW_MAX_FRACTION;
  const commit = commitDistance(width);
  const a = Math.abs(dx);
  const t = a <= commit ? a : commit + (a - commit) * 0.35;
  return Math.sign(dx) * Math.min(t, limit);
}

/** What happens when the finger lifts at dx: the action, or null to snap back. */
export function swipeResult(dx: number, width: number, canArchive: boolean): RowSwipeAction | null {
  const action = actionFor(dx, canArchive);
  if (!action) return null;
  return Math.abs(dx) >= commitDistance(width) ? action : null;
}
