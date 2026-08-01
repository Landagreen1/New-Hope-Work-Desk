// src/app/api/attendance/export/route.ts
// GET /api/attendance/export?view=…&from=YYYY-MM-DD&to=YYYY-MM-DD&<the view's filters>
//
// The six CSV exports of Requirement 15, criterion 1, from one endpoint. They
// differ by `view` rather than by route, because they are six column lists over
// the reads the screens already use — one endpoint per view would be six places
// to forget the pay-column rule.
//
// ## What comes back
//
// A `text/csv` body, not JSON. The name is `exportFileName`'s, carrying the active
// range and every active filter value (Requirement 15, criterion 6), and it is
// safe to quote directly in `Content-Disposition`: `exportFileName` admits letters,
// digits, hyphens, and the group underscores only, so there is no character to
// escape and no need for the `filename*` form.
//
// Two response headers carry what the file itself cannot:
//
// - `X-Export-Rows` — the data rows, header excluded.
// - `X-Export-Notice` — Requirement 15, criterion 8's statement that no records
//   matched, present only when none did. Percent-encoded, because a filter value
//   in it can be non-ASCII and a header field cannot; a caller reads it back with
//   `decodeURIComponent`. The file still carries its header row, which is the other
//   half of the criterion.
//
// ## The byte-order mark belongs here
//
// `toCsv` writes none, deliberately: prepending `\ufeff` inside the writer would
// put it inside the first header field, where a strict reader would see it as part
// of the first column's name. It is prepended here instead, next to the
// `charset=utf-8` that declares the encoding, so Excel reads a non-ASCII employee
// name correctly while the writer stays a pure function of its rows.
//
// ## Authorisation
//
// `resolveActor` first, so nothing about the request is read before the caller
// exists. Scope is then `visibleProfileIds` inside each service read, and the
// pay-rate and pay-amount columns are removed for a caller who does not administer
// attendance (Requirement 15, criterion 9). A query naming an employee outside the
// caller's visibility is refused rather than answered with an empty file, which
// would read as "no records" instead of "not yours".
//
// Requirements: 15.1, 15.2, 15.3, 15.4, 15.5, 15.6, 15.7, 15.8, 15.9, 21.1,
// 21.15, 22.16

import {
  refuseInvisibleProfiles,
  resolveActor,
} from '@/features/time-attendance/server/api-actor';
import { serviceFailure } from '@/features/time-attendance/server/api-response';
import { exportView } from '@/features/time-attendance/server/export-service';
import { parseExportQuery } from '@/features/time-attendance/server/request-query';

export const runtime = 'nodejs';

/**
 * The UTF-8 byte-order mark.
 *
 * Excel reads a CSV without one as the system code page, which turns every
 * non-ASCII character in an employee name or a manager note into mojibake. Every
 * other reader that matters skips it.
 */
const UTF8_BOM = '\ufeff';

export async function GET(request: Request) {
  const resolved = await resolveActor();
  if (!resolved.ok) return resolved.response;

  try {
    const { searchParams } = new URL(request.url);
    const { view, query } = parseExportQuery(searchParams);

    // Every employee the query names, from whichever of the three filter shapes
    // carries them, checked before a single attendance row is read.
    const named = [
      ...(query.records?.profileIds ?? []),
      ...(query.requests?.profileIds ?? []),
      ...(query.profileId === undefined ? [] : [query.profileId]),
    ];
    const refusal = await refuseInvisibleProfiles(resolved.actor, named);
    if (refusal !== null) return refusal;

    const file = await exportView(resolved.actor, view, query, { client: resolved.client });

    const headers = new Headers({
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${file.filename}"`,
      'X-Export-Rows': String(file.rowCount),
      // A CSV is a per-caller, row-level-security-scoped read of live attendance
      // data. Nothing about it should be held anywhere.
      'Cache-Control': 'no-store',
    });
    if (file.notice !== null) {
      headers.set('X-Export-Notice', encodeURIComponent(file.notice));
    }

    return new Response(`${UTF8_BOM}${file.csv}`, { status: 200, headers });
  } catch (error) {
    return serviceFailure(error);
  }
}
