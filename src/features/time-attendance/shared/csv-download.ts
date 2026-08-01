// src/features/time-attendance/shared/csv-download.ts
// The one path a CSV export takes from `/api/attendance/export` to the reader's
// disk.
//
// `/api/attendance/export` answers with a `text/csv` body the module never
// re-decides: `toCsv` has already quoted every field and doubled every embedded
// quote, `exportFileName` has already named the file for its range and its
// filters, and the route has already prepended the UTF-8 byte-order mark that
// lets Excel read a non-ASCII employee name. What is left for a caller is to ask,
// to hand the bytes to the browser unchanged, and to read back the two facts the
// file itself cannot carry:
//
//   - `X-Export-Rows` — the data rows, header excluded.
//   - `X-Export-Notice` — Requirement 15, criterion 8's statement that no records
//     matched, present only when none did, percent-encoded because a filter value
//     inside it can be non-ASCII and a header field cannot.
//
// This lives in `shared/` because two screens need it. `ExportsView` triggers the
// six exports of the Review Center, and `PayrollProcessor` asks the same endpoint
// for `payroll_ready` in place of the CSV it used to build in the browser with
// `rows.map(r => r.join(','))` — which quoted nothing, so an employee name
// carrying a comma split into two columns. A third copy of the download would be
// a third opportunity for one of them to start quoting differently.
//
// Requirements: 15.1, 15.4, 15.6, 15.8, 22.16

import type { ExportView } from '../domain/csv';

import { ApiFailureError, apiFailureOf, isAbortError, transportFailure } from './api-failure';

/** What one completed export turned out to contain. */
export interface CsvDownload {
  /** The name the file was written under. */
  filename: string;
  /** Data rows, header excluded, from `X-Export-Rows`. */
  rowCount: number;
  /** Requirement 15, criterion 8's statement, when nothing matched. */
  notice: string | null;
}

/** The file name the route put in `Content-Disposition`. */
export function exportFilenameOf(disposition: string | null, fallback: string): string {
  if (disposition === null) return fallback;
  const quoted = /filename="([^"]+)"/.exec(disposition);
  return quoted === null ? fallback : quoted[1];
}

/** The row count the route reported, or the honest zero when it reported none. */
export function exportRowCountOf(header: string | null): number {
  if (header === null) return 0;
  const parsed = Number(header);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

/**
 * `X-Export-Notice`, decoded.
 *
 * A value that will not decode is carried as sent rather than dropped: the
 * statement matters more than its punctuation.
 */
export function exportNoticeOf(header: string | null): string | null {
  if (header === null || header === '') return null;
  try {
    return decodeURIComponent(header);
  } catch {
    return header;
  }
}

/**
 * Fetch one export and hand the file to the browser.
 *
 * The body is written to the blob exactly as it arrived, byte-order mark
 * included: re-deciding the encoding here would be a second opinion about it.
 *
 * @param url the `/api/attendance/export` request, filters and all
 * @param fallbackFilename used only when the response carried no
 *   `Content-Disposition`, which a proxy can strip
 * @throws ApiFailureError for a refused or failed request, so a caller renders
 *   the reason through the same contract every other read uses
 *
 * Requirements: 15.4, 15.6, 15.8, 22.16
 */
export async function downloadCsvExport(
  url: string,
  fallbackFilename: string,
): Promise<CsvDownload> {
  let response: Response;
  try {
    response = await fetch(url);
  } catch (error) {
    if (isAbortError(error)) throw error;
    console.error('[time-attendance] export request could not be sent', url, error);
    throw new ApiFailureError(transportFailure());
  }

  if (!response.ok) throw new ApiFailureError(await apiFailureOf(response));

  const csv = await response.text();
  const filename = exportFilenameOf(response.headers.get('content-disposition'), fallbackFilename);

  const blobUrl = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const anchor = document.createElement('a');
  anchor.href = blobUrl;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  // Revoked on the next macrotask rather than immediately: some browsers cancel a
  // download whose blob URL is released in the same task as the click.
  setTimeout(() => URL.revokeObjectURL(blobUrl), 0);

  return {
    filename,
    rowCount: exportRowCountOf(response.headers.get('x-export-rows')),
    notice: exportNoticeOf(response.headers.get('x-export-notice')),
  };
}

/**
 * The `payroll_ready` export for one pay period.
 *
 * The period is the whole filter. `payroll_ready` reads through `payrollInputs`
 * in `legacy_parity` mode, which resolves the roster and the figures from the
 * database rather than from anything the browser is holding — so the payroll
 * screen's current calculation and one of its processed periods are the same
 * request with different dates.
 *
 * Requirements: 15.1, 2.2
 */
export function payrollExportUrl(from: string, to: string): string {
  // Typed against the domain's export vocabulary, so dropping or renaming the
  // view is a compile error here rather than a 400 the payroll screen discovers
  // at run time.
  const view: ExportView = 'payroll_ready';
  const params = new URLSearchParams({ view, from, to });
  return `/api/attendance/export?${params.toString()}`;
}
