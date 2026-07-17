export const ui = {
  page: 'mx-auto max-w-[1500px] px-4 py-6 sm:px-6 lg:px-8',
  pageTitle: 'text-2xl font-black tracking-tight text-slate-950 sm:text-3xl',
  pageSubtitle: 'mt-2 max-w-3xl text-sm font-semibold leading-6 text-slate-500',
  sectionTitle: 'text-xs font-black uppercase tracking-[0.16em] text-slate-500',
  card: 'rounded-[26px] border border-slate-200 bg-white shadow-sm',
  cardPad: 'p-5 sm:p-6',
  cardHeader: 'flex flex-col gap-3 border-b border-slate-100 px-5 py-5 sm:flex-row sm:items-center sm:justify-between sm:px-6',
  stat: 'rounded-3xl border border-slate-200 bg-white px-5 py-4 shadow-sm',
  statLabel: 'text-[11px] font-black uppercase tracking-[0.14em] text-slate-400',
  statValue: 'mt-1 text-3xl font-black tracking-tight text-slate-950',
  btnPrimary: 'inline-flex items-center justify-center gap-2 rounded-xl bg-[#223f7a] px-4 py-2.5 text-sm font-black text-white transition hover:bg-[#17305f] disabled:cursor-not-allowed disabled:opacity-40',
  btnSecondary: 'inline-flex items-center justify-center gap-2 rounded-xl border border-[#c9d5e9] bg-white px-4 py-2.5 text-sm font-black text-[#223f7a] transition hover:bg-[#f3f6fb] disabled:cursor-not-allowed disabled:opacity-40',
  btnDanger: 'inline-flex items-center justify-center gap-2 rounded-xl border border-rose-200 bg-rose-50 px-4 py-2.5 text-sm font-black text-rose-700 transition hover:bg-rose-100 disabled:cursor-not-allowed disabled:opacity-40',
  btnGhost: 'inline-flex items-center justify-center gap-2 rounded-xl px-3 py-2 text-sm font-black text-slate-600 transition hover:bg-slate-100',
  label: 'block text-xs font-black uppercase tracking-[0.12em] text-slate-500',
  input: 'mt-2 w-full rounded-xl border border-slate-200 bg-white px-3.5 py-2.5 text-sm font-semibold text-slate-900 outline-none transition placeholder:text-slate-400 focus:border-[#7890bc] focus:ring-4 focus:ring-[#eef3fb]',
  select: 'mt-2 w-full rounded-xl border border-slate-200 bg-white px-3.5 py-2.5 text-sm font-semibold text-slate-900 outline-none transition focus:border-[#7890bc] focus:ring-4 focus:ring-[#eef3fb]',
  textarea: 'mt-2 w-full rounded-xl border border-slate-200 bg-white px-3.5 py-2.5 text-sm font-semibold text-slate-900 outline-none transition placeholder:text-slate-400 focus:border-[#7890bc] focus:ring-4 focus:ring-[#eef3fb]',
  fieldRow: 'grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3',
  checkboxRow: 'flex items-center gap-2 text-sm font-semibold text-slate-700',
  table: 'min-w-full text-left text-sm',
  th: 'border-b border-slate-200 bg-slate-50 px-4 py-3 text-[11px] font-black uppercase tracking-wider text-slate-400',
  td: 'border-b border-slate-100 px-4 py-3 align-top text-slate-700',
  trHover: 'cursor-pointer transition hover:bg-[#f8faff]',
  badge: 'inline-flex items-center rounded-full px-2.5 py-1 text-[11px] font-black ring-1',
  badgeTone: {
    neutral: 'bg-slate-100 text-slate-700 ring-slate-200',
    info: 'bg-blue-50 text-blue-700 ring-blue-200',
    progress: 'bg-amber-50 text-amber-800 ring-amber-200',
    success: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
    danger: 'bg-rose-50 text-rose-700 ring-rose-200',
    violet: 'bg-violet-50 text-violet-700 ring-violet-200',
    cyan: 'bg-cyan-50 text-cyan-700 ring-cyan-200',
  } as Record<string, string>,
  error: 'rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-bold text-rose-800',
  success: 'rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-bold text-emerald-800',
  info: 'rounded-2xl border border-blue-200 bg-blue-50 px-4 py-3 text-sm font-semibold leading-6 text-blue-900',
  empty: 'rounded-3xl border border-dashed border-slate-300 bg-slate-50 px-6 py-12 text-center text-sm font-semibold text-slate-500',
};

export const csIntakeStatusTone: Record<string, string> = {
  draft: 'neutral', submitted: 'info', claimed: 'progress', converted: 'success', returned: 'violet', rejected: 'danger', deleted: 'danger',
};

export const renewalStatusTone: Record<string, string> = {
  imported: 'neutral', assigned: 'info', in_progress: 'progress', monitoring: 'violet', requote_sent: 'cyan', renewed: 'success', lost: 'danger', cancelled: 'danger',
};

export function statusLabel(value: string): string {
  return value.replace(/_/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}
