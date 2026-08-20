'use client';

/**
 * The workspace's small parts.
 *
 * Nothing here is a new design language: every class comes from `ui`, which is the
 * app's single vocabulary, so a Specialty Quote page looks like the rest of the Work
 * Desk without a second theme to keep in step. What these components add is the
 * repetition — a labelled field, a read-only row, a section card, a small contextual
 * editor — so a panel file contains its own subject and not fifty lines of chrome.
 */

import { AlertTriangle, Check, Loader2, X } from 'lucide-react';
import { useEffect, useRef, type ReactNode } from 'react';

import { ui } from '../../nhwd-shared/ui';
import type { Tone } from '../status';

/** One action, then a reload. Returned true when the server accepted it. */
export type Runner = (action: () => Promise<void>, success: string) => Promise<boolean>;

export function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: ReactNode;
  hint?: string;
}) {
  return (
    <label className="block">
      <span className={ui.label}>{label}</span>
      {children}
      {hint ? <span className="mt-1.5 block text-xs font-semibold text-slate-400">{hint}</span> : null}
    </label>
  );
}

/** A label/value pair. Absent values render nothing rather than an empty row. */
export function ReadRow({ label, value }: { label: string; value: ReactNode }) {
  if (value === null || value === undefined || value === '' || value === '—') return null;
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-slate-100 py-2 last:border-0">
      <span className="text-xs font-black uppercase tracking-[0.1em] text-slate-400">{label}</span>
      <span className="text-right text-sm font-bold text-slate-800">{value}</span>
    </div>
  );
}

export function SectionCard({
  title,
  description,
  actions,
  children,
  bodyClassName,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
  /** Override when the body owns its own padding, such as a full-bleed table. */
  bodyClassName?: string;
}) {
  return (
    <section className={ui.card}>
      <div className={ui.cardHeader}>
        <div className="min-w-0">
          <p className={ui.sectionTitle}>{title}</p>
          {description ? (
            <p className="mt-1 text-xs font-semibold text-slate-500">{description}</p>
          ) : null}
        </div>
        {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
      <div className={bodyClassName ?? 'p-5 sm:p-6'}>{children}</div>
    </section>
  );
}

/** A compact figure. Used by the quote-health strip and the carrier summary. */
export function Stat({
  label,
  value,
  hint,
  tone = 'neutral',
}: {
  label: string;
  value: ReactNode;
  hint?: string | null;
  tone?: Tone;
}) {
  const valueColour =
    tone === 'danger'
      ? 'text-rose-700'
      : tone === 'success'
        ? 'text-emerald-700'
        : tone === 'progress'
          ? 'text-amber-700'
          : tone === 'violet'
            ? 'text-violet-700'
            : tone === 'cyan'
              ? 'text-cyan-700'
              : 'text-slate-950';

  return (
    <div className="rounded-2xl border border-slate-200 bg-white px-4 py-3">
      <p className={ui.statLabel}>{label}</p>
      <p className={`mt-0.5 text-xl font-black tracking-tight ${valueColour}`}>{value}</p>
      {hint ? <p className="mt-0.5 text-xs font-bold text-slate-400">{hint}</p> : null}
    </div>
  );
}

export function Badge({ tone, children }: { tone: Tone; children: ReactNode }) {
  return <span className={`${ui.badge} ${ui.badgeTone[tone]}`}>{children}</span>;
}

const DOT_COLOURS: Record<Tone, string> = {
  neutral: 'bg-slate-300',
  info: 'bg-blue-500',
  progress: 'bg-amber-500',
  success: 'bg-emerald-500',
  danger: 'bg-rose-500',
  violet: 'bg-violet-500',
  cyan: 'bg-cyan-500',
};

export function toneDotColour(tone: Tone): string {
  return DOT_COLOURS[tone];
}

/**
 * A small contextual editor.
 *
 * The workspace has no global "Edit Quote" form: coverage is edited from Coverage, a
 * driver from that driver, a premium from that carrier. Those are small jobs, so they
 * get a small centred dialog rather than another full screen — which is the one place
 * the spec still wants an overlay.
 *
 * Focus moves into the dialog on open and Escape closes it. Deliberately not a full
 * focus trap: `SideDrawer` owns that behaviour for the drawers that remain, and
 * duplicating it here would be a second implementation to keep correct.
 */
export function EditModal({
  title,
  description,
  onClose,
  onSubmit,
  submitLabel = 'Save',
  submitDisabled = false,
  busy = false,
  error,
  wide = false,
  children,
}: {
  title: string;
  description?: string;
  onClose: () => void;
  onSubmit?: () => void;
  submitLabel?: string;
  submitDisabled?: boolean;
  busy?: boolean;
  error?: string | null;
  wide?: boolean;
  children: ReactNode;
}) {
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleKey(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [onClose]);

  useEffect(() => {
    const first = panel.current?.querySelector<HTMLElement>(
      'input, select, textarea, button:not([data-dismiss])',
    );
    first?.focus();
  }, []);

  return (
    /*
     * No dismiss on the backdrop.
     *
     * These dialogs hold real work — a driver's licence details, twenty coverage fields —
     * and the overlay scrolls, so a mousedown on its own scrollbar, or a text drag that
     * ends outside the panel, would throw all of it away with no confirmation. Escape,
     * the close button and Cancel are three deliberate ways out; a stray click is not one
     * of them.
     */
    <div
      className="fixed inset-0 z-[70] overflow-y-auto bg-slate-950/50 p-3 backdrop-blur-sm sm:p-6"
      role="presentation"
    >
      <div
        ref={panel}
        className={`mx-auto rounded-[28px] border border-slate-200 bg-white shadow-2xl ${
          wide ? 'max-w-4xl' : 'max-w-2xl'
        }`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="flex items-start justify-between gap-3 border-b border-slate-100 px-5 py-4 sm:px-6">
          <div className="min-w-0">
            <h2 className="text-base font-black text-slate-950">{title}</h2>
            {description ? (
              <p className="mt-1 text-xs font-semibold text-slate-500">{description}</p>
            ) : null}
          </div>
          <button
            type="button"
            data-dismiss
            onClick={onClose}
            className="rounded-lg p-2 text-slate-400 transition hover:bg-slate-100"
            aria-label={`Close ${title}`}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="max-h-[68vh] overflow-y-auto px-5 py-5 sm:px-6">
          {error ? <div className={`${ui.error} mb-4`}>{error}</div> : null}
          {children}
        </div>

        {onSubmit ? (
          <div className="flex flex-wrap items-center justify-end gap-2 border-t border-slate-100 px-5 py-4 sm:px-6">
            <button type="button" data-dismiss className={ui.btnGhost} onClick={onClose}>
              Cancel
            </button>
            <button
              type="button"
              className={ui.btnPrimary}
              disabled={submitDisabled || busy}
              onClick={onSubmit}
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
              {submitLabel}
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** The standard "nothing here yet" and "still loading" bodies. */
export function Placeholder({ children }: { children: ReactNode }) {
  return <p className={ui.empty}>{children}</p>;
}

export function LoadingBlock({ label }: { label: string }) {
  return (
    <div className="flex min-h-[160px] items-center justify-center rounded-3xl border border-dashed border-slate-200 bg-slate-50">
      <div className="flex flex-col items-center gap-2">
        <Loader2 className="h-5 w-5 animate-spin text-[#223f7a]" />
        <p className="text-sm font-bold text-slate-500">{label}</p>
      </div>
    </div>
  );
}

/** A list of named gaps. The workspace never invents a completion percentage. */
export function MissingList({ items, title }: { items: readonly string[]; title?: string }) {
  if (items.length === 0) return null;
  return (
    <div className="rounded-2xl border border-rose-100 bg-rose-50/60 px-4 py-3">
      <p className="flex items-center gap-1.5 text-xs font-black uppercase tracking-[0.1em] text-rose-700">
        <AlertTriangle className="h-3.5 w-3.5" />
        {title ?? 'Missing'}
      </p>
      {/* Keyed on the position, not the text: two drivers with the same name legitimately
          produce the same gap sentence twice. */}
      <ul className="mt-1.5 space-y-1">
        {items.map((item, index) => (
          <li key={`${index}-${item}`} className="text-sm font-semibold text-rose-900">
            • {item}
          </li>
        ))}
      </ul>
    </div>
  );
}
