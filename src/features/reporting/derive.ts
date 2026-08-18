/**
 * Display helpers for the Sales Reporting Center.
 *
 * Spec: .kiro/specs/sales-reporting-center-redesign
 * Requirements: 4.7, 11.2, 12.8, 18.6
 *
 * Pure. No React, no Supabase.
 *
 * The recurring theme is that an undefined value must read as undefined. A conversion
 * rate over zero finalized quotes is not zero percent, and a median over an empty
 * sample is not zero minutes. Every formatter here renders an em dash rather than a
 * misleading number.
 */

import type { KpiWindow, ReportFilters } from './types';

export const EM_DASH = '\u2014';

export function formatCount(value: number | null | undefined): string {
  if (value === null || value === undefined) return EM_DASH;
  return new Intl.NumberFormat('en-US').format(value);
}

/** A percentage, or an em dash when the rate is undefined. Never "0%" for undefined. */
export function formatPercent(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined || Number.isNaN(value)) return EM_DASH;
  return `${value.toFixed(digits)}%`;
}

export function formatRatio(value: number | null | undefined, digits = 2): string {
  if (value === null || value === undefined || Number.isNaN(value)) return EM_DASH;
  return value.toFixed(digits);
}

/** Minutes as a human duration. Undefined stays undefined. */
export function formatMinutes(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return EM_DASH;
  const minutes = Math.round(value);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours < 24) return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return restHours === 0 ? `${days}d` : `${days}d ${restHours}h`;
}

export function formatDate(iso: string | null | undefined, timeZone = 'America/New_York'): string {
  if (iso === null || iso === undefined) return EM_DASH;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return EM_DASH;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('month')}/${get('day')}/${get('year')}`;
}

export function formatDateTime(
  iso: string | null | undefined,
  timeZone = 'America/New_York',
): string {
  if (iso === null || iso === undefined) return EM_DASH;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return EM_DASH;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('month')}/${get('day')}/${get('year')} ${get('hour')}:${get('minute')} ${get('dayPeriod')}`;
}

export interface Delta {
  absolute: number;
  percent: number | null;
  direction: 'up' | 'down' | 'flat';
}

/**
 * The change between two comparable values.
 *
 * `percent` is null when the previous value was zero, because a change from zero has no
 * percentage. Reporting "+100%" for one sale after a quiet week would overstate it.
 */
export function computeDelta(
  current: number | null | undefined,
  previous: number | null | undefined,
): Delta | null {
  if (current === null || current === undefined) return null;
  if (previous === null || previous === undefined) return null;
  const absolute = current - previous;
  return {
    absolute,
    percent: previous === 0 ? null : (absolute / previous) * 100,
    direction: absolute > 0 ? 'up' : absolute < 0 ? 'down' : 'flat',
  };
}

export function formatDelta(delta: Delta | null, isPercentMetric = false): string {
  if (delta === null) return EM_DASH;
  if (delta.direction === 'flat') return 'no change';
  const sign = delta.absolute > 0 ? '+' : '';
  if (isPercentMetric) return `${sign}${delta.absolute.toFixed(1)} pts`;
  const magnitude = `${sign}${formatCount(delta.absolute)}`;
  if (delta.percent === null) return `${magnitude} (from zero)`;
  return `${magnitude} (${sign}${delta.percent.toFixed(1)}%)`;
}

/** Whether a metric is expressed in percentage points rather than as a count. */
export function isPercentMetric(metricId: string): boolean {
  return metricId === 'conversion_rate' || metricId === 'quote_to_sale_rate';
}

export function kpiValue(window: KpiWindow | undefined, metricId: string): number | null {
  if (window === undefined) return null;
  switch (metricId) {
    case 'quotes_received':
      return window.quotes_received;
    case 'pricing_sent':
      return window.pricing_sent;
    case 'pending_pricing':
      return window.pending_pricing;
    case 'finalized':
      return window.finalized;
    case 'sold':
      return window.sold;
    case 'not_sold':
      return window.not_sold;
    case 'conversion_rate':
      return window.conversion_rate;
    case 'quote_to_sale_rate':
      return window.quote_to_sale_rate;
    case 'median_time_to_pricing':
      return window.median_time_to_pricing_minutes;
    default:
      return null;
  }
}

export function formatKpi(value: number | null, metricId: string): string {
  if (metricId === 'median_time_to_pricing') return formatMinutes(value);
  if (isPercentMetric(metricId)) return formatPercent(value);
  return formatCount(value);
}

/** A share of a total, or null when the total is zero. */
export function shareOf(part: number | null | undefined, total: number | null | undefined): number | null {
  if (part === null || part === undefined) return null;
  if (total === null || total === undefined || total === 0) return null;
  return (part / total) * 100;
}

/** One line describing the active filter state, written into every export header. */
export function describeFilters(filters: ReportFilters, timeZone = 'America/New_York'): string {
  const parts: string[] = [
    `View: ${filters.view}`,
    `Mode: ${filters.mode === 'cohort' ? 'Quote Cohort' : 'Operational Activity'}`,
    `Period: ${filters.startDate} to ${filters.endDate} (${timeZone})`,
    `Hours: ${filters.hoursSegment}`,
  ];
  if (filters.afterHoursDimensions.length > 0) {
    parts.push(`After-hours dimensions: ${filters.afterHoursDimensions.join(', ')}`);
  }
  if (filters.agentProfileIds.length > 0) parts.push(`Agents: ${filters.agentProfileIds.length} selected`);
  if (filters.dealerIds.length > 0) parts.push(`Sources: ${filters.dealerIds.length} selected`);
  if (filters.salespersonIds.length > 0) parts.push(`Salespeople: ${filters.salespersonIds.length} selected`);
  if (filters.channels.length > 0) parts.push(`Channels: ${filters.channels.join(', ')}`);
  if (filters.quoteKinds.length > 0) parts.push(`Quote kind: ${filters.quoteKinds.join(', ')}`);
  if (filters.assignmentMethods.length > 0) parts.push(`Methods: ${filters.assignmentMethods.join(', ')}`);
  if (filters.statuses.length > 0) parts.push(`Statuses: ${filters.statuses.join(', ')}`);
  if (filters.outcomes.length > 0) parts.push(`Outcomes: ${filters.outcomes.join(', ')}`);
  if (filters.compareToPreviousPeriod) parts.push('Compared with the previous period');
  return parts.join(' | ');
}

/** Inclusive day count of the active window. Drives the comparison period label. */
export function windowLengthDays(filters: ReportFilters): number {
  const start = Date.parse(`${filters.startDate}T00:00:00Z`);
  const end = Date.parse(`${filters.endDate}T00:00:00Z`);
  if (Number.isNaN(start) || Number.isNaN(end)) return 0;
  return Math.round((end - start) / 86_400_000) + 1;
}

export function severityTone(severity: string): string {
  switch (severity) {
    case 'high':
      return 'danger';
    case 'medium':
      return 'progress';
    default:
      return 'neutral';
  }
}

export function reviewStatusTone(status: string): string {
  switch (status) {
    case 'Open':
      return 'progress';
    case 'Explained':
      return 'success';
    case 'Confirmed Data Issue':
      return 'danger';
    case 'Dismissed':
      return 'neutral';
    default:
      return 'neutral';
  }
}

export function outcomeTone(outcome: string | null): string {
  if (outcome === 'sold') return 'success';
  if (outcome === 'not_sold') return 'danger';
  return 'neutral';
}

export function lifecycleLabel(stage: string): string {
  switch (stage) {
    case 'active':
      return 'Active';
    case 'pending_pricing':
      return 'Pending Pricing';
    case 'finalized':
      return 'Finalized';
    default:
      return stage;
  }
}

export function notSoldReasonLabel(reason: string | null, other: string | null = null): string {
  if (reason === null) return EM_DASH;
  switch (reason) {
    case 'price_too_high':
      return 'Price too high';
    case 'chose_another_option':
      return 'Chose another option';
    case 'no_response':
      return 'No response';
    case 'no_longer_needed':
      return 'No longer needed';
    case 'other':
      return other !== null && other.length > 0 ? other : 'Other';
    default:
      return reason;
  }
}

export function assignmentMethodLabel(method: string | null): string {
  if (method === null) return EM_DASH;
  switch (method) {
    case 'whatsapp_turn':
      return 'WhatsApp turn';
    case 'ringcentral_turn':
      return 'RingCentral turn';
    case 'workload_turn':
      return 'Workload turn';
    case 'manual_quote':
      return 'Manual quote';
    case 'manual_workload':
      return 'Manual workload';
    case 'manager_manual':
      return 'Manager assignment';
    case 'update_log':
      return 'Update log';
    case 'payment_log':
      return 'Payment log';
    case 'customer_service':
      return 'Customer Service';
    case 'owner':
      return 'Owner';
    default:
      return method.replace(/_/g, ' ');
  }
}
