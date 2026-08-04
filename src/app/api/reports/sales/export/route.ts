import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';

import { canManageSales } from '@/lib/permissions';
import { createClient } from '@/lib/supabase/server';

export const runtime = 'nodejs';

/**
 * POST /api/reports/sales/export
 *
 * Spec: .kiro/specs/sales-reporting-center-redesign
 * Requirements: 18.1-18.7, 19.5, 19.7
 *
 * The single export path for the Sales Reporting Center, in four formats.
 *
 * Every format is produced here rather than in the browser, and every one re-runs the
 * same RPCs the screen used. That is what makes "export totals match the screen"
 * structural: there is one query, so the file and the page cannot diverge. The eight
 * client-side CSV builders this replaces each assembled their own rows from already-loaded
 * data, and one of them ignored the date range entirely.
 *
 * Authorization is checked here too. Requirement 19.7: an export respects the same
 * permissions as the report it came from, and the RPCs additionally refuse on their own.
 */

const MAX_RECORDS = 10_000;
const PAGE_SIZE = 500;

type ExportFormat = 'summary_csv' | 'records_csv' | 'xlsx' | 'pdf';

interface ExportRequest {
  format?: string;
  view?: string;
  sort?: string;
  filters?: Record<string, unknown>;
}

function csvEscape(value: unknown): string {
  const text = value === null || value === undefined ? '' : String(value);
  return `"${text.replaceAll('"', '""')}"`;
}

function toCsv(rows: Array<Record<string, unknown>>, headerLines: string[]): string {
  const commentBlock = headerLines.map((line) => `# ${line}`).join('\n');
  if (rows.length === 0) {
    return `${commentBlock}\n\n(no records matched)\n`;
  }
  // Union the keys across every row rather than reading them off the first one. The
  // legacy exporter used Object.keys(rows[0]), so a first row missing an optional field
  // dropped that column for every row.
  const headers = Array.from(
    rows.reduce<Set<string>>((keys, row) => {
      Object.keys(row).forEach((key) => keys.add(key));
      return keys;
    }, new Set<string>()),
  );
  const body = [
    headers.map(csvEscape).join(','),
    ...rows.map((row) => headers.map((header) => csvEscape(row[header])).join(',')),
  ].join('\n');
  return `${commentBlock}\n\n${body}\n`;
}

function describeFilters(filters: Record<string, unknown>, view: string, timeZone: string): string[] {
  const list = (key: string): string => {
    const value = filters[key];
    return Array.isArray(value) && value.length > 0 ? value.join(', ') : 'all';
  };
  return [
    'New Hope Work Desk — Sales Reporting Center export',
    `View: ${view}`,
    `Report mode: ${filters.mode === 'cohort' ? 'Quote Cohort' : 'Operational Activity'}`,
    `Period: ${String(filters.start_date)} to ${String(filters.end_date)} (${timeZone})`,
    `Hours segment: ${String(filters.hours_segment ?? 'all')}`,
    `After-hours dimensions: ${list('after_hours_dimensions')}`,
    `Agents: ${list('agent_profile_ids')}`,
    `Sources: ${list('dealer_ids')}`,
    `Salespeople: ${list('salesperson_ids')}`,
    `Channels: ${list('channels')}`,
    `Quote kinds: ${list('quote_kinds')}`,
    `Assignment methods: ${list('assignment_methods')}`,
    `Statuses: ${list('statuses')}`,
    `Outcomes: ${list('outcomes')}`,
    `Generated: ${new Intl.DateTimeFormat('en-US', {
      timeZone,
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(new Date())} (${timeZone})`,
  ];
}

export async function POST(request: Request) {
  const supabase = await createClient();
  if (!supabase) {
    return Response.json({ error: 'Supabase is not configured.' }, { status: 503 });
  }

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return Response.json({ error: 'Authentication required.' }, { status: 401 });
  }

  const { data: profile } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .single();

  if (!profile || !canManageSales(profile.role)) {
    return Response.json({ error: 'Sales management access required.' }, { status: 403 });
  }

  let body: ExportRequest;
  try {
    body = (await request.json()) as ExportRequest;
  } catch {
    return Response.json({ error: 'Expected a JSON body.' }, { status: 400 });
  }

  const format = (body.format ?? 'summary_csv') as ExportFormat;
  if (!['summary_csv', 'records_csv', 'xlsx', 'pdf'].includes(format)) {
    return Response.json({ error: `Unknown export format: ${format}` }, { status: 400 });
  }
  const view = body.view ?? 'overview';
  const sort = body.sort ?? 'created_at_desc';
  const filters = body.filters ?? {};

  // Same RPCs the screen calls, so the numbers cannot differ.
  const [summaryResult, lifecycleResult, agentResult, sourceResult, afterHoursResult] =
    await Promise.all([
      supabase.rpc('report_summary', { p_filters: filters }),
      supabase.rpc('report_lifecycle', { p_filters: filters }),
      supabase.rpc('report_agent_rows', { p_filters: filters }),
      supabase.rpc('report_source_rows', { p_filters: filters }),
      supabase.rpc('report_after_hours_summary', { p_filters: filters }),
    ]);

  const firstError =
    summaryResult.error ?? lifecycleResult.error ?? agentResult.error ??
    sourceResult.error ?? afterHoursResult.error;
  if (firstError) {
    return Response.json({ error: firstError.message }, { status: 400 });
  }

  const summary = summaryResult.data as {
    authorized?: boolean;
    timezone?: string;
    current?: Record<string, unknown>;
    previous?: Record<string, unknown> | null;
  };
  if (summary?.authorized === false) {
    return Response.json({ error: 'Not authorized to read this report.' }, { status: 403 });
  }

  const timeZone = summary?.timezone ?? 'America/New_York';
  const headerLines = describeFilters(filters as Record<string, unknown>, view, timeZone);
  const stamp = `${String((filters as Record<string, unknown>).start_date)}-to-${String(
    (filters as Record<string, unknown>).end_date,
  )}`;

  /** The summary sheet: one row per metric, with the comparison column when enabled. */
  function summaryRows(): Array<Record<string, unknown>> {
    const current = (summary?.current ?? {}) as Record<string, unknown>;
    const previous = (summary?.previous ?? null) as Record<string, unknown> | null;
    const lifecycle = (lifecycleResult.data ?? {}) as Record<string, unknown>;
    const afterHours = (afterHoursResult.data ?? {}) as Record<string, unknown>;

    const metrics: Array<[string, string]> = [
      ['Quotes Received', 'quotes_received'],
      ['Pricing Sent', 'pricing_sent'],
      ['Pending Pricing (as of period end)', 'pending_pricing'],
      ['Finalized', 'finalized'],
      ['Sold', 'sold'],
      ['Not Sold', 'not_sold'],
      ['Conversion Rate % (Sold / Finalized)', 'conversion_rate'],
      ['Quote-to-Sale Rate % (Sold / Quotes Received)', 'quote_to_sale_rate'],
      ['Median Time to Pricing (minutes)', 'median_time_to_pricing_minutes'],
    ];

    const rows: Array<Record<string, unknown>> = metrics.map(([label, key]) => ({
      Section: 'KPI',
      Metric: label,
      Value: current[key] ?? '',
      'Previous Period': previous === null ? '' : (previous[key] ?? ''),
    }));

    if (filters && (filters as Record<string, unknown>).mode === 'cohort') {
      for (const [label, key] of [
        ['Received', 'received'],
        ['Accepted', 'accepted'],
        ['Priced', 'priced'],
        ['Finalized', 'finalized'],
        ['Sold', 'sold'],
        ['Not Sold', 'not_sold'],
        ['Awaiting Customer Decision', 'awaiting_customer_decision'],
        ['Still Pending Pricing', 'still_pending_pricing'],
        ['Still Active', 'still_active'],
      ] as Array<[string, string]>) {
        rows.push({
          Section: 'Quote Cohort lifecycle',
          Metric: label,
          Value: lifecycle[key] ?? '',
          'Previous Period': '',
        });
      }
    }

    for (const [label, key] of [
      ['Quotes received after hours', 'quotes_received_after_hours'],
      ['Quotes worked after hours', 'quotes_worked_after_hours'],
      ['Quotes finalized after hours', 'quotes_finalized_after_hours'],
      ['Manual Quotes after hours', 'manual_quotes_after_hours'],
      ['Manual Workloads after hours', 'manual_workloads_after_hours'],
      ['After-hours conversion rate %', 'after_hours_conversion_rate'],
      ['Median wait to first action (minutes)', 'median_wait_to_first_action_minutes'],
      ['Waiting until the next business day', 'quotes_waiting_until_next_business_day'],
    ] as Array<[string, string]>) {
      rows.push({
        Section: 'After hours',
        Metric: label,
        Value: afterHours[key] ?? '',
        'Previous Period': '',
      });
    }

    return rows;
  }

  // Narrowed above, but captured here so the closures below do not re-widen it.
  const db = supabase;

  async function detailRows(): Promise<{
    rows: Array<Record<string, unknown>>;
    truncated: boolean;
    total: number;
  }> {
    if (view === 'agents') {
      const rows = (agentResult.data ?? []) as Array<Record<string, unknown>>;
      return { rows, truncated: false, total: rows.length };
    }
    if (view === 'sources') {
      const rows = (sourceResult.data ?? []) as Array<Record<string, unknown>>;
      return { rows, truncated: false, total: rows.length };
    }

    // Overview and Integrity export the underlying quote records.
    const metric =
      (filters as Record<string, unknown>).mode === 'cohort' ? 'quotes_received' : 'quotes_received';
    const collected: Array<Record<string, unknown>> = [];
    let total = 0;
    for (let offset = 0; offset < MAX_RECORDS; offset += PAGE_SIZE) {
      const { data, error } = await db.rpc('report_records', {
        p_filters: filters,
        p_metric: metric,
        p_limit: PAGE_SIZE,
        p_offset: offset,
        p_sort: sort,
      });
      if (error) throw new Error(error.message);
      const page = (data ?? []) as Array<Record<string, unknown>>;
      if (page.length === 0) break;
      total = Number(page[0].total_count ?? 0);
      collected.push(...page.map(({ total_count: _ignored, ...rest }) => rest));
      if (collected.length >= total) break;
    }
    return { rows: collected, truncated: total > MAX_RECORDS, total };
  }

  try {
    if (format === 'summary_csv') {
      const csv = toCsv(summaryRows(), headerLines);
      return new Response(csv, {
        headers: {
          'Content-Type': 'text/csv;charset=utf-8',
          'Content-Disposition': `attachment; filename="sales-summary-${view}-${stamp}.csv"`,
        },
      });
    }

    if (format === 'records_csv') {
      const detail = await detailRows();
      if (detail.truncated) {
        return Response.json(
          {
            error: `This export would contain ${detail.total} records, above the ${MAX_RECORDS} limit. Narrow the period or the filters.`,
          },
          { status: 413 },
        );
      }
      const csv = toCsv(detail.rows, headerLines);
      return new Response(csv, {
        headers: {
          'Content-Type': 'text/csv;charset=utf-8',
          'Content-Disposition': `attachment; filename="sales-records-${view}-${stamp}.csv"`,
        },
      });
    }

    if (format === 'xlsx') {
      const detail = await detailRows();
      if (detail.truncated) {
        return Response.json(
          {
            error: `This export would contain ${detail.total} records, above the ${MAX_RECORDS} limit. Narrow the period or the filters.`,
          },
          { status: 413 },
        );
      }

      const workbook = new ExcelJS.Workbook();
      workbook.creator = 'New Hope Work Desk';
      workbook.created = new Date();

      const about = workbook.addWorksheet('About this export');
      about.columns = [{ width: 110 }];
      headerLines.forEach((line) => about.addRow([line]));

      const summarySheet = workbook.addWorksheet('Summary');
      const summaryData = summaryRows();
      summarySheet.columns = [
        { header: 'Section', key: 'Section', width: 28 },
        { header: 'Metric', key: 'Metric', width: 46 },
        { header: 'Value', key: 'Value', width: 16 },
        { header: 'Previous Period', key: 'Previous Period', width: 18 },
      ];
      summaryData.forEach((row) => summarySheet.addRow(row));
      summarySheet.getRow(1).font = { bold: true };

      const recordsSheet = workbook.addWorksheet('Records');
      if (detail.rows.length > 0) {
        const headers = Array.from(
          detail.rows.reduce<Set<string>>((keys, row) => {
            Object.keys(row).forEach((key) => keys.add(key));
            return keys;
          }, new Set<string>()),
        );
        recordsSheet.columns = headers.map((header) => ({
          header,
          key: header,
          width: Math.min(34, Math.max(14, header.length + 4)),
        }));
        detail.rows.forEach((row) => recordsSheet.addRow(row));
        recordsSheet.getRow(1).font = { bold: true };
      } else {
        recordsSheet.addRow(['(no records matched)']);
      }

      const buffer = await workbook.xlsx.writeBuffer();
      return new Response(buffer as ArrayBuffer, {
        headers: {
          'Content-Type':
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          'Content-Disposition': `attachment; filename="sales-report-${view}-${stamp}.xlsx"`,
        },
      });
    }

    // PDF snapshot of the summary. Deliberately the summary only: a printable page of
    // ten thousand records is not a snapshot, and the records CSV and workbook already
    // carry the detail.
    const chunks: Buffer[] = [];
    const pdf = new PDFDocument({ size: 'LETTER', margin: 48 });
    pdf.on('data', (chunk: Buffer) => chunks.push(chunk));
    const finished = new Promise<void>((resolve) => pdf.on('end', () => resolve()));

    pdf.fontSize(18).text('Sales Reporting Center', { continued: false });
    pdf.moveDown(0.3);
    pdf.fontSize(10).fillColor('#555555');
    headerLines.slice(1).forEach((line) => pdf.text(line));
    pdf.moveDown(0.8);
    pdf.fillColor('#000000');

    let section = '';
    for (const row of summaryRows()) {
      const rowSection = String(row.Section);
      if (rowSection !== section) {
        section = rowSection;
        pdf.moveDown(0.5).fontSize(12).text(section, { underline: true });
        pdf.moveDown(0.2).fontSize(10);
      }
      const value = row.Value === '' || row.Value === null ? '—' : String(row.Value);
      const previous =
        row['Previous Period'] === '' || row['Previous Period'] === null
          ? ''
          : `   (previous: ${String(row['Previous Period'])})`;
      pdf.text(`${String(row.Metric)}: ${value}${previous}`);
    }

    pdf.end();
    await finished;

    return new Response(new Uint8Array(Buffer.concat(chunks)), {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="sales-report-${view}-${stamp}.pdf"`,
      },
    });
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : 'Export failed.';
    return Response.json({ error: message }, { status: 500 });
  }
}
