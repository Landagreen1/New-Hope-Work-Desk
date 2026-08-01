// src/features/time-attendance/shared/threshold-draft.ts
// What the Workforce screen's staffing-threshold editor decides before it sends
// anything: which of the 84 slots the administrator has actually changed, whether
// each change is legible, and what the resulting bands mean.
//
// Separated from the component for the reason `domain/csv.ts` is separated from
// the export view: the judgements here — an emptied field, a slot the
// administrator asked to clear, a pair that looks changed and is not — are the
// part worth testing, and they are testable without a DOM only if no React
// touches them.
//
// ## The distinction this module exists to keep
//
// `staffing_thresholds` says two different things with two different absences,
// and an editor that blurred them would be a bug the coverage panel then reports
// as a staffing warning:
//
//   * **A slot with no row is unconfigured.** `thresholdFor` answers null, which
//     reports required staffing as unconfigured and Coverage_Status Healthy
//     (Requirement 6, criterion 4). Saturday and Sunday carry no rows on purpose.
//   * **A slot storing `0 / 0` requires nobody and warns at nobody.**
//     `classifyCoverage` reads an empty department as At Minimum against that
//     pair, which the health ribbon presents as Warning.
//
// So a draft cell is either a typed pair or the explicit intent to clear, and
// `CLEARED` is a distinct value rather than an empty pair. `draftEdits` turns the
// first into an assignment and the second into a clear, and turns neither into a
// zero.
//
// Requirements: 2.3, 6.3, 6.4, 20.1, 20.2, 22.15, 22.16

import {
  MAX_REQUIRED_STAFF,
  THRESHOLD_REJECTION_REASON,
  coverageBands,
  rejectThreshold,
  slotKey,
  type CoverageBand,
  type ThresholdSlot,
} from '../domain/coverage';
import type { Threshold } from '../domain/types';
import type { Department, TimeSlot } from '../types';

// ─── Vocabulary ──────────────────────────────────────────────────────────────

/**
 * The weekday names, indexed by `staffing_thresholds.day_of_week`.
 *
 * 0 is Sunday, which is the column's own convention and not JavaScript's
 * coincidentally matching one: the figures are configuration keyed by an integer,
 * not dates, so nothing here converts a date to a day.
 */
export const WEEKDAY_LABELS: readonly string[] = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
];

/**
 * What each time slot is, in the words the editor uses.
 *
 * The description says which reading compares against which slot, because the
 * lookup is exact and an administrator who assumed `full_day` was a fallback would
 * configure a requirement that never fires for a live reading.
 */
export const TIME_SLOT_DESCRIPTIONS: Readonly<Record<TimeSlot, { label: string; help: string }>> = {
  morning: {
    label: 'Morning',
    help: 'Live coverage before 12:00 in the business timezone compares against this row.',
  },
  afternoon: {
    label: 'Afternoon',
    help: 'Live coverage from 12:00 onward compares against this row.',
  },
  full_day: {
    label: 'Full day',
    help: 'Projected coverage for a whole date, and every leave decision, compares against this row.',
  },
};

/** The slots the editor shows, in the order it shows them. */
export const EDITOR_TIME_SLOTS: readonly TimeSlot[] = ['morning', 'afternoon', 'full_day'];

/** The days the editor shows, Monday first: the working week before the weekend. */
export const EDITOR_DAYS_OF_WEEK: readonly number[] = [1, 2, 3, 4, 5, 6, 0];

// ─── The draft ───────────────────────────────────────────────────────────────

/**
 * The administrator's intent to return a slot to unconfigured.
 *
 * A value of its own rather than a pair of empty strings, so "make this slot
 * carry no requirement" cannot be confused with "I have started typing".
 */
export const CLEARED = 'cleared' as const;

/** One cell of the form: the two figures as typed. */
export interface DraftPair {
  minimum: string;
  warning: string;
}

/** One drafted slot: a typed pair, or the intent to clear it. */
export type DraftCell = DraftPair | typeof CLEARED;

/** The whole draft, keyed by `slotKey`. A slot absent from it is unchanged. */
export type ThresholdDraft = Readonly<Record<string, DraftCell>>;

export function isCleared(cell: DraftCell | null | undefined): cell is typeof CLEARED {
  return cell === CLEARED;
}

/** One slot's stored figures, or null when the slot is unconfigured. */
export type StoredThresholds = ReadonlyMap<string, Threshold>;

/** The stored entries as a lookup, so a cell can be compared against its row. */
export function storedByKey(
  entries: readonly (ThresholdSlot & Threshold)[],
): Map<string, Threshold> {
  return new Map(
    entries.map((entry) => [
      slotKey(entry),
      { minimumStaff: entry.minimumStaff, warningThreshold: entry.warningThreshold },
    ]),
  );
}

/** The pair a cell shows: the draft where there is one, the stored row otherwise. */
export function cellValue(
  slot: ThresholdSlot,
  draft: ThresholdDraft,
  stored: StoredThresholds,
): DraftCell | null {
  const drafted = draft[slotKey(slot)];
  if (drafted !== undefined) return drafted;

  const row = stored.get(slotKey(slot));
  return row === undefined
    ? null
    : { minimum: String(row.minimumStaff), warning: String(row.warningThreshold) };
}

// ─── What a draft would send ─────────────────────────────────────────────────

/** One slot to store, in the body shape `PATCH /api/attendance/thresholds` reads. */
export interface ThresholdSlotBody {
  department: Department;
  day_of_week: number;
  time_slot: TimeSlot;
  minimum_staff?: number;
  warning_threshold?: number;
  clear?: true;
}

/** A figure as a whole number of people, or null when the text is not one. */
export function parseHeadcount(text: string): number | null {
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) return null;

  const value = Number(trimmed);
  return Number.isSafeInteger(value) && value <= MAX_REQUIRED_STAFF ? value : null;
}

/** What the editor sends, or the one reason it cannot send anything. */
export type DraftPatch = { slots: ThresholdSlotBody[] } | { invalid: string };

/** A slot in the words the editor shows on the form. */
export function slotLabel(slot: ThresholdSlot, departmentLabel: string): string {
  return `${departmentLabel}, ${WEEKDAY_LABELS[slot.dayOfWeek] ?? `day ${slot.dayOfWeek}`}, ${TIME_SLOT_DESCRIPTIONS[slot.timeSlot].label.toLowerCase()}`;
}

/** Every drafted slot, resolved back into the slot it names. */
function draftedSlots(draft: ThresholdDraft, order: readonly ThresholdSlot[]): ThresholdSlot[] {
  return order.filter((slot) => draft[slotKey(slot)] !== undefined);
}

/**
 * The `slots` body a draft would send, or the reason it would not.
 *
 * `order` is every slot the editor can address, so the request lists the changed
 * cells in the order the form shows them and a refusal names the first one a
 * reader would look at.
 *
 * Four outcomes per drafted cell:
 *
 * | draft         | stored        | sent                              |
 * | ------------- | ------------- | --------------------------------- |
 * | `CLEARED`     | a row         | `{ clear: true }`                 |
 * | `CLEARED`     | nothing       | nothing — already unconfigured    |
 * | a legible pair | different or absent | the pair                    |
 * | a legible pair | the same figures | nothing — `06` is not a change |
 *
 * A cell with one field filled and the other empty is refused rather than
 * completed with a zero: a half-typed pair is not a requirement of none.
 *
 * Requirements: 6.3, 6.4, 20.1, 20.2
 */
export function draftEdits(
  draft: ThresholdDraft,
  stored: StoredThresholds,
  order: readonly ThresholdSlot[],
  labelOf: (slot: ThresholdSlot) => string,
): DraftPatch {
  const slots: ThresholdSlotBody[] = [];

  for (const slot of draftedSlots(draft, order)) {
    const key = slotKey(slot);
    const cell = draft[key];
    const row = stored.get(key);

    if (isCleared(cell)) {
      // Already unconfigured: nothing to remove, and sending a clear for a slot
      // with no row would be a write that changes nothing.
      if (row !== undefined) {
        slots.push({
          department: slot.department,
          day_of_week: slot.dayOfWeek,
          time_slot: slot.timeSlot,
          clear: true,
        });
      }
      continue;
    }

    const minimumStaff = parseHeadcount(cell.minimum);
    const warningThreshold = parseHeadcount(cell.warning);

    if (minimumStaff === null || warningThreshold === null) {
      return {
        invalid:
          `${labelOf(slot)}: minimum staff and warning threshold must each be a whole number ` +
          `of people between 0 and ${MAX_REQUIRED_STAFF}. Clear the slot instead to remove its requirement.`,
      };
    }

    const rejection = rejectThreshold({ minimumStaff, warningThreshold });
    if (rejection !== null) {
      return { invalid: `${labelOf(slot)}: ${THRESHOLD_REJECTION_REASON[rejection]}` };
    }

    // The figures match what is stored: the text differs without the pair
    // differing, as `06` does for `6`.
    if (
      row !== undefined &&
      row.minimumStaff === minimumStaff &&
      row.warningThreshold === warningThreshold
    ) {
      continue;
    }

    slots.push({
      department: slot.department,
      day_of_week: slot.dayOfWeek,
      time_slot: slot.timeSlot,
      minimum_staff: minimumStaff,
      warning_threshold: warningThreshold,
    });
  }

  return { slots };
}

// ─── The bands a cell means ──────────────────────────────────────────────────

/**
 * One band as a headcount range in words: `0–5`, `6`, `7–8`, `9 or more`.
 *
 * Requirements: 6.9, 6.10, 6.11, 6.12
 */
export function bandRange(band: CoverageBand): string {
  if (band.to === null) return `${band.from} or more`;
  return band.from === band.to ? String(band.from) : `${band.from}\u2013${band.to}`;
}

/** One band, ready to render: its status, its range, and its label. */
export interface BandSummary {
  status: CoverageBand['status'];
  range: string;
}

/**
 * The bands a cell's typed pair would produce, or null when the pair is not yet
 * legible.
 *
 * Null rather than a guess: a cell mid-keystroke has no bands to show, and
 * inventing them from a partial figure would flicker a Warning band the
 * administrator never asked for.
 *
 * Requirements: 6.9, 6.10, 6.11, 6.12
 */
export function cellBands(cell: DraftCell | null): BandSummary[] | null {
  if (cell === null || isCleared(cell)) return null;

  const minimumStaff = parseHeadcount(cell.minimum);
  const warningThreshold = parseHeadcount(cell.warning);
  if (minimumStaff === null || warningThreshold === null) return null;

  const threshold = { minimumStaff, warningThreshold };
  if (rejectThreshold(threshold) !== null) return null;

  return coverageBands(threshold).map((band) => ({ status: band.status, range: bandRange(band) }));
}
