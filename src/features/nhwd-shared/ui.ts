// src/features/nhwd-shared/ui.ts
// -----------------------------------------------------------------------------
// SINGLE SOURCE OF STYLE for the CS Intake and Renewals modules.
//
// Every visual decision in both modules routes through these exported strings.
// To match the existing Work Desk design, edit ONLY this file: swap the
// Tailwind classes below for the ones work-desk-app.tsx already uses
// (its button, card, badge, and table classes). Nothing else needs touching.
// -----------------------------------------------------------------------------

export const ui = {
  // page scaffolding
  page: 'mx-auto max-w-6xl px-4 py-6',
  pageTitle: 'text-xl font-semibold text-slate-900',
  pageSubtitle: 'mt-1 text-sm text-slate-500',
  sectionTitle: 'text-sm font-semibold uppercase tracking-wide text-slate-500',

  // cards / panels
  card: 'rounded-lg border border-slate-200 bg-white shadow-sm',
  cardPad: 'p-4',
  cardHeader: 'flex items-center justify-between border-b border-slate-200 px-4 py-3',

  // stat tiles (used on both landing pages)
  stat: 'rounded-lg border border-slate-200 bg-white px-4 py-3',
  statLabel: 'text-xs font-medium uppercase tracking-wide text-slate-500',
  statValue: 'mt-1 text-2xl font-semibold text-slate-900',

  // buttons
  btnPrimary:
    'inline-flex items-center gap-1.5 rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-40',
  btnSecondary:
    'inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40',
  btnDanger:
    'inline-flex items-center gap-1.5 rounded-md border border-red-300 bg-white px-3 py-1.5 text-sm font-medium text-red-700 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-40',
  btnGhost:
    'inline-flex items-center rounded-md px-2 py-1 text-sm text-slate-600 hover:bg-slate-100',

  // form controls
  label: 'block text-xs font-medium text-slate-600',
  input:
    'mt-1 w-full rounded-md border border-slate-300 px-2.5 py-1.5 text-sm text-slate-900 placeholder:text-slate-400 focus:border-slate-500 focus:outline-none',
  select:
    'mt-1 w-full rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-sm text-slate-900 focus:border-slate-500 focus:outline-none',
  textarea:
    'mt-1 w-full rounded-md border border-slate-300 px-2.5 py-1.5 text-sm text-slate-900 focus:border-slate-500 focus:outline-none',
  fieldRow: 'grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3',
  checkboxRow: 'flex items-center gap-2 text-sm text-slate-700',

  // tables
  table: 'w-full text-left text-sm',
  th: 'border-b border-slate-200 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-slate-500',
  td: 'border-b border-slate-100 px-3 py-2 text-slate-800 align-top',
  trHover: 'hover:bg-slate-50 cursor-pointer',

  // status badges — keyed by module status values
  badge: 'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium',
  badgeTone: {
    neutral: 'bg-slate-100 text-slate-700',
    info: 'bg-blue-100 text-blue-800',
    progress: 'bg-amber-100 text-amber-800',
    success: 'bg-green-100 text-green-800',
    danger: 'bg-red-100 text-red-800',
    violet: 'bg-violet-100 text-violet-800',
  } as Record<string, string>,

  // notices
  error: 'rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800',
  success: 'rounded-md border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-800',
  empty: 'px-4 py-10 text-center text-sm text-slate-500',
};

export const csIntakeStatusTone: Record<string, string> = {
  draft: 'neutral',
  submitted: 'info',
  claimed: 'progress',
  converted: 'success',
  returned: 'violet',
  rejected: 'danger',
};

export const renewalStatusTone: Record<string, string> = {
  imported: 'neutral',
  assigned: 'info',
  in_progress: 'progress',
  monitoring: 'violet',
  requote_sent: 'info',
  renewed: 'success',
  lost: 'danger',
  cancelled: 'danger',
};

export function statusLabel(s: string): string {
  return s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}
