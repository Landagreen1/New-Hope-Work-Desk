// src/features/time-attendance/server/inbox-service.ts
// The Needs_Attention_Inbox as one read: three existing reads issued together,
// handed to `buildInbox`, answered in a single response.
//
// Requirement 17, criterion 9 asks for the whole item set in one request, and
// criterion 3 names seven categories that live on three different screens. Those
// two together are the whole of this module: it is the composition step, and it
// derives nothing.
//
// ## Why it issues no query of its own
//
// Each of the seven categories is a property the owning screen's read already
// established, so each source here is that screen's own read:
//
// | source                 | read                              | categories                                                                                  |
// | ---------------------- | --------------------------------- | ------------------------------------------------------------------------------------------- |
// | Daily_Attendance_Records | `getAllRecords`                 | payroll-blocking, missing punch, unapproved unscheduled work, unapproved correction, unresolved exception |
// | Request_Inbox rows     | `listAllRequests`                 | pending request                                                                             |
// | Projected_Coverage     | `getCoverage`, `projected`        | critical coverage                                                                           |
//
// A second read of the same rows — or worse, a second opinion about whether a
// punch is missing or a date is critical — is what Requirement 19, criterion 8
// forbids, and it is what would let the inbox and the screen that owns a record
// disagree about that record. `buildInbox` reads the flags the three reads
// produced and nothing else.
//
// ## Scope
//
// Requirement 17, criterion 8 restricts a non-administrator to their own items,
// and it is already settled: each read resolves its scope through
// `visibleProfileIds`, which for a non-administrator is their own id. Nothing here
// filters a second time.
//
// Coverage is the one source that is not read for a non-administrator, and for the
// reason `listAllRequests` gives for withholding its coverage-risk column: their
// visibility is a roster of one, so a projection computed over it would be
// staffing figures for a single employee labelled with a Coverage_Status — a
// definite claim from data that cannot support it. A critical date is also an item
// about a date and nobody in particular, so it is not an item "belonging to the
// signed-in Employee" in the first place.
//
// ## The three windows
//
// Nothing in Requirement 17 states how far the inbox looks, so each window is the
// owning screen's own:
//
// - **Records** take the Attendance_Service's fallback fortnight ending today, so
//   the records the inbox lists are the records an unranged Exception_Queue read
//   returns.
// - **Requests** take the Request_Inbox's own window, which the PTO service
//   resolves. The inbox therefore lists the pending requests that screen lists.
// - **Coverage** runs from today forward over a fortnight. It is the one
//   forward-looking source: a date already past cannot be staffed differently, so
//   listing it as unresolved would be listing something nobody can resolve.
//
// The instant is read once, in `getInbox`, and passed to all three reads, so the
// three describe the same moment and every item's age is measured against it.
//
// Requirements: 17.1, 17.2, 17.3, 17.4, 17.5, 17.6, 17.7, 17.8, 17.9, 17.10,
// 20.1, 20.2, 21.1, 21.2

import {
  buildInbox,
  INBOX_CATEGORY_ORDER,
  type InboxCategory,
  type InboxEmployee,
  type InboxEmployeeIndex,
  type InboxItem,
} from '../domain/inbox';
import type { DateRange } from '../domain/types';
import { addCalendarDays, workDateOf } from '../domain/work-date';
import { getAllRecords, type AttendanceEmployee } from './attendance-service';
import {
  getCoverage,
  isComputedCoverageDate,
  type CoverageContext,
} from './coverage-service';
import { loadAttendanceConfig, loadAttendancePolicy, loadStaffingThresholds } from './policy';
import { listAllRequests } from './pto-service';
import { canReviewTeamAttendance, type Actor } from './visibility';

/**
 * How many dates of projected coverage the inbox looks ahead over, counting
 * today: a fortnight.
 *
 * Long enough that a critical date is found while a schedule can still be
 * changed, and short enough that the projection is over dates whose schedules are
 * actually published. The Health_Ribbon's seven dates are the same question asked
 * over a shorter horizon, and both read the same Coverage_Service, so the two
 * cannot disagree about a date they both cover.
 *
 * Requirements: 17.3
 */
export const INBOX_COVERAGE_DAYS = 14;

/** Everything an inbox read needs besides the caller. */
export type InboxContext = CoverageContext;

/** The dates each source was read over. */
export interface InboxWindows {
  /** The Daily_Attendance_Records window: the service's fallback fortnight. */
  records: DateRange;
  /** The Request_Inbox window, as the PTO service resolved it. */
  requests: DateRange;
  /** The projected-coverage window, or null when coverage was not read. */
  coverage: DateRange | null;
}

/** What one inbox read returns. */
export interface InboxResponse {
  /** The instant every source was read at, and every age measured to. */
  evaluatedAt: string;
  /**
   * Every unresolved item, worst first: one item per underlying record, ordered
   * by category severity then by age.
   *
   * Requirements: 17.4, 17.7
   */
  items: InboxItem[];
  /**
   * `items.length` — the count Requirement 17, criterion 2 asks the control to
   * display, carried so a collapsed inbox can render it without walking the list.
   */
  unresolvedCount: number;
  /**
   * How many items each category is the *worst* category of, so the counts sum to
   * `unresolvedCount` rather than double-counting a record that qualified under
   * several categories (Requirement 17, criterion 4).
   */
  counts: Record<InboxCategory, number>;
  windows: InboxWindows;
  /** True when the item set could cover employees other than the caller. */
  teamScope: boolean;
  /**
   * Whether projected coverage was read. False for a non-administrator, whose
   * visibility cannot support a staffing figure — see the module note.
   */
  coverageIncluded: boolean;
}

/**
 * The configuration, read once for the whole composite request.
 *
 * The three reads each accept a policy and a threshold table, so loading them
 * here means `attendance_policy` and `staffing_thresholds` are read once between
 * them rather than once per read.
 */
async function resolveConfig(context: InboxContext) {
  if (context.policy !== undefined && context.thresholds !== undefined) {
    return { policy: context.policy, thresholds: context.thresholds };
  }
  if (context.policy !== undefined) {
    return { policy: context.policy, thresholds: await loadStaffingThresholds(context.client) };
  }
  if (context.thresholds !== undefined) {
    return { policy: await loadAttendancePolicy(context.client), thresholds: context.thresholds };
  }
  return loadAttendanceConfig(context.client);
}

/**
 * The employees the items name, from the rosters the reads already returned.
 *
 * First mention wins, and the two rosters are the same `profiles` rows read under
 * the same scope, so which one supplies a given employee cannot change the name
 * an item carries.
 */
function employeeIndex(
  ...rosters: readonly (readonly AttendanceEmployee[])[]
): InboxEmployeeIndex {
  const index = new Map<string, InboxEmployee>();

  for (const roster of rosters) {
    for (const employee of roster) {
      if (index.has(employee.profileId)) continue;
      index.set(employee.profileId, {
        profileId: employee.profileId,
        employeeName: employee.displayName,
        department: employee.department,
      });
    }
  }

  return index;
}

/** One tally per category, with every category present at zero. */
function countByCategory(items: readonly InboxItem[]): Record<InboxCategory, number> {
  const counts = Object.fromEntries(
    INBOX_CATEGORY_ORDER.map((category) => [category, 0]),
  ) as Record<InboxCategory, number>;

  for (const item of items) counts[item.category] += 1;
  return counts;
}

/**
 * Everything unresolved across the module, in one read.
 *
 * Three reads issued together, one call to `buildInbox`, and no derivation of its
 * own. The outbound query count is a property of the three reads rather than of
 * the roster size, the number of unresolved items, or the length of the windows.
 *
 * Criterion 10 needs nothing here: the item set is rebuilt from the sources on
 * every call, so a record that no longer qualifies contributes no item to the next
 * one.
 *
 * @throws AttendanceServiceError as the three reads throw it — `read_failed` for
 *   a source read that failed, `invalid_range` for a window a read refuses. Every
 *   code already has a shape in `api-response.ts`.
 *
 * Requirements: 17.3, 17.4, 17.5, 17.7, 17.8, 17.9, 17.10
 */
export async function getInbox(actor: Actor, context: InboxContext): Promise<InboxResponse> {
  const evaluatedAt = context.evaluatedAt ?? new Date().toISOString();
  const { policy, thresholds } = await resolveConfig(context);

  const shared = { ...context, evaluatedAt, policy, thresholds };
  const today = workDateOf(new Date(evaluatedAt), policy.businessTimezone);
  const coverageWindow: DateRange = {
    from: today,
    to: addCalendarDays(today, INBOX_COVERAGE_DAYS - 1),
  };

  const [records, requests, coverage] = await Promise.all([
    // No range: the Attendance_Service's own fallback fortnight, so the inbox
    // lists the records an unranged Exception_Queue read returns.
    getAllRecords(actor, {}, shared),
    // The status filter is what the inbox is asking for rather than a narrowing of
    // its own: `buildInbox` takes the rows whose `pending` flag is set, which is
    // the same rows. Naming it here keeps the read from building rows the item set
    // has no use for.
    listAllRequests(actor, { statuses: ['pending'] }, shared),
    canReviewTeamAttendance(actor.role)
      ? getCoverage(actor, { ...coverageWindow, mode: 'projected' }, shared)
      : Promise.resolve(null),
  ]);

  const items = buildInbox({
    evaluatedAt,
    records: records.rows,
    requests: requests.rows,
    // A date whose projection could not be computed carries no figures, so it
    // makes no claim about staffing and contributes no item.
    coverage: (coverage?.dates ?? [])
      .filter(isComputedCoverageDate)
      .map((date) => date.projection),
    employees: employeeIndex(records.employees, requests.employees),
  });

  return {
    evaluatedAt,
    items,
    unresolvedCount: items.length,
    counts: countByCategory(items),
    windows: {
      records: records.range,
      requests: requests.range,
      coverage: coverage?.range ?? null,
    },
    teamScope: canReviewTeamAttendance(actor.role),
    coverageIncluded: coverage !== null,
  };
}
