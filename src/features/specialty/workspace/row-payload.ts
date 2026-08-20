/**
 * Building the driver or vehicle array to send back.
 *
 * `specialty_update_intake` replaces the whole list when it is given one — that is how the
 * intake form itself saves them — so editing one driver means sending all of them. Getting
 * that wrong is a data-loss bug rather than a cosmetic one, which is why it lives here as a
 * pure function rather than inside the dialog that calls it.
 *
 * Two decisions carry the weight:
 *
 * 1. **Rows are passed through as they arrived.** The payload from
 *    `specialty_opportunity_detail` is `to_jsonb(row)`, so each object carries every
 *    column — including ones the TypeScript interface does not name, such as a driver's
 *    `incidents` array and a vehicle's `coverage` map. Rebuilding from the interface would
 *    silently drop them.
 * 2. **The edited row is found by id, not by position.** The dialog is open for as long as
 *    somebody is typing, and the list underneath refreshes on a teammate's change, on
 *    window focus and after any action. An index captured at open time then names a
 *    different driver.
 */

/** A row as the server sent it: every column, not just the typed ones. */
export type RawRow = Record<string, unknown>;

export type RowTarget = { kind: 'existing'; id: string } | { kind: 'new' };

/** What a dialog is editing. A row with no id is a new one. */
export function rowTarget(existing: RawRow | null | undefined): RowTarget {
  const id = existing?.id;
  return typeof id === 'string' ? { kind: 'existing', id } : { kind: 'new' };
}

/**
 * The full array to send back, with one row added, replaced or removed.
 *
 * Returns null when the target has vanished from under the dialog, so the caller can say so
 * rather than appending a duplicate or deleting somebody else's row.
 *
 * Positions are renumbered from one: position is what the carrier application prints, and a
 * gap after a removal reads as a missing driver.
 */
export function applyRow(
  rows: readonly RawRow[],
  target: RowTarget,
  draft: RawRow,
  removing: boolean,
): RawRow[] | null {
  let next: RawRow[];

  if (target.kind === 'new') {
    // There is nothing to remove that was never saved.
    if (removing) return null;
    next = [...rows, draft];
  } else {
    const at = rows.findIndex((row) => row.id === target.id);
    if (at === -1) return null;
    next = removing
      ? rows.filter((_, position) => position !== at)
      : rows.map((row, position) => (position === at ? draft : row));
  }

  return next.map((row, position) => ({ ...row, position: position + 1 }));
}
