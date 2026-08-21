'use client';

/**
 * The submission composer.
 *
 * Spec: .kiro/specs/carrier-email-submission, Requirements 5, 6, 10.
 *
 * Everything is pre-filled and everything is editable. The pre-fill is a starting point,
 * not a decision: an agent who knows this carrier wants the loss runs first should be able
 * to say so without leaving the screen.
 *
 * The idempotency key is generated ONCE when the dialog opens and reused for every attempt
 * from that instance. That is what makes a double-click, or a retry after a timeout, send
 * one email rather than two — the server refuses the second insert on the unique
 * constraint and hands back the original submission.
 */

import { AlertTriangle, Loader2, Paperclip, Send, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { ui } from '../../nhwd-shared/ui';
import {
  SubmissionSendError,
  sendSubmission,
  type SendSubmissionResponse,
} from '../../carrier-submissions/api';
import {
  DEFAULT_BODY_TEMPLATE,
  DEFAULT_SUBJECT_TEMPLATE,
  SUBMISSION_PLACEHOLDERS,
  buildCoverageLines,
  buildCoverageSummary,
  findUnresolvedPlaceholders,
  formatCoverageLines,
  renderTemplate,
} from '../../carrier-submissions/templates';
import { formatRecipientList, parseRecipientList } from '../../carrier-submissions/recipients';
import type { SubmissionKind } from '../../carrier-submissions/types';
import { getMarket } from '../market-directory/api';
import type { MarketDirectoryEntry } from '../market-directory/types';
import { buildTruckingDataPacket } from '../market-directory/trucking-data-adapter';
import { formatFileSize } from '../status';
import type { CarrierMarket, OpportunityDetail, SpecialtyDocument } from '../types';

const KIND_LABELS: Record<SubmissionKind, string> = {
  initial: 'Initial submission',
  additional_documents: 'Additional documents',
  revised: 'Revised submission',
};

export default function PrepareSubmissionDialog({
  detail,
  market,
  senderAddress,
  onClose,
  onSent,
}: {
  detail: OpportunityDetail;
  market: CarrierMarket;
  senderAddress: string;
  onClose: () => void;
  onSent: (result: SendSubmissionResponse) => void;
}) {
  const [config, setConfig] = useState<MarketDirectoryEntry | null>(null);
  const [loading, setLoading] = useState(true);
  const [to, setTo] = useState('');
  const [cc, setCc] = useState('');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [kind, setKind] = useState<SubmissionKind>('initial');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  /**
   * Generated once per dialog instance. Not per attempt — that is the whole point: the
   * server refuses a second insert on the same key, so a double-click or a retry after a
   * timeout produces one email and returns the original submission.
   *
   * A lazy `useState` initializer rather than `useRef(generate())`, because a `useRef`
   * argument is evaluated on every render — it would have minted and discarded a fresh
   * UUID each time, which is both wasteful and impure during render.
   */
  const [idempotencyKey] = useState<string>(() =>
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );

  const companyName = detail.opportunity.display_name;

  const coverageLines = useMemo(() => {
    if (!detail.intake) return [];
    try {
      return buildCoverageLines(buildTruckingDataPacket(detail.intake).coverages);
    } catch {
      // A homeowners quote has no trucking coverages. Not an error — just no block.
      return [];
    }
  }, [detail.intake]);

  /** The generated application for THIS carrier, newest first. Never another carrier's. */
  const carrierApplication = useMemo(() => {
    return detail.documents
      .filter((doc) => doc.category === 'generated_application' && doc.carrier_market_id === market.id)
      .sort((a, b) => b.created_at.localeCompare(a.created_at))[0] as SpecialtyDocument | undefined;
  }, [detail.documents, market.id]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      if (!market.market_directory_id) {
        setLoading(false);
        return;
      }
      try {
        const entry = await getMarket(market.market_directory_id);
        if (!cancelled) setConfig(entry);
      } catch {
        if (!cancelled) setConfig(null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [market.market_directory_id]);

  // Seed the form once the market configuration is in.
  useEffect(() => {
    if (loading) return;
    const vars = {
      company_name: companyName,
      carrier_name: market.carrier_name,
      sender_name: senderAddress,
      coverage_summary: buildCoverageSummary(coverageLines),
      coverage_lines: formatCoverageLines(coverageLines),
    };
    setTo(formatRecipientList(config?.submission_email ? [config.submission_email] : []));
    setCc(formatRecipientList(config?.submission_cc ?? []));
    setSubject(renderTemplate(config?.submission_subject_template || DEFAULT_SUBJECT_TEMPLATE, vars));
    setBody(renderTemplate(config?.submission_body_template || DEFAULT_BODY_TEMPLATE, vars));
    setSelected(new Set(carrierApplication ? [carrierApplication.id] : []));
  }, [loading, config, companyName, market.carrier_name, senderAddress, coverageLines, carrierApplication]);

  const toParsed = useMemo(() => parseRecipientList(to), [to]);
  const ccParsed = useMemo(() => parseRecipientList(cc), [cc]);
  const unresolved = findUnresolvedPlaceholders(`${subject}\n${body}`);

  const attachments = detail.documents.filter((doc) => selected.has(doc.id));
  const totalBytes = attachments.reduce((sum, doc) => sum + (doc.file_size ?? 0), 0);

  const blockers: string[] = [];
  if (!market.market_directory_id) {
    blockers.push(
      'This carrier is not linked to a Market Directory entry, so it has no submission address. A manager can link it under User Administration → Market Directory.',
    );
  } else if (config && !config.email_submission_enabled) {
    blockers.push(`Email submission is turned off for ${config.name}. A manager can enable it.`);
  }
  if (toParsed.valid.length === 0) blockers.push('Add at least one recipient.');
  if (toParsed.invalid.length > 0) blockers.push(`Not a valid address: ${toParsed.invalid.join(', ')}`);
  if (ccParsed.invalid.length > 0) blockers.push(`Not a valid CC address: ${ccParsed.invalid.join(', ')}`);
  if (!subject.trim()) blockers.push('Add a subject.');

  const toggle = useCallback((id: string) => {
    setSelected((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const submit = useCallback(async () => {
    setSending(true);
    setError(null);
    try {
      const result = await sendSubmission({
        opportunityId: detail.opportunity.id,
        carrierMarketId: market.id,
        marketId: market.market_directory_id,
        carrierName: market.carrier_name,
        to: toParsed.valid,
        cc: ccParsed.valid,
        subject,
        body,
        documentIds: [...selected],
        submissionKind: kind,
        idempotencyKey,
      });
      onSent(result);
    } catch (err) {
      if (err instanceof SubmissionSendError) {
        setError(err.retryable ? `${err.message} This one is worth trying again.` : err.message);
      } else {
        setError(err instanceof Error ? err.message : 'The submission could not be sent.');
      }
    } finally {
      setSending(false);
    }
  }, [detail.opportunity.id, market, toParsed, ccParsed, subject, body, selected, kind, idempotencyKey, onSent]);

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-slate-950/40 p-4">
      <div className="flex max-h-[92vh] w-full max-w-3xl flex-col overflow-hidden rounded-[26px] bg-white shadow-2xl">
        <header className="flex items-center justify-between border-b border-slate-100 px-6 py-5">
          <div>
            <h2 className="text-lg font-black tracking-tight text-slate-950">Prepare submission</h2>
            <p className="mt-1 text-sm font-semibold text-slate-500">
              {market.carrier_name} · {companyName}
            </p>
          </div>
          <button type="button" className={ui.btnGhost} onClick={onClose} aria-label="Close">
            <X className="h-5 w-5" />
          </button>
        </header>

        <div className="flex-1 overflow-y-auto px-6 py-5">
          {loading ? (
            <p className="text-sm font-semibold text-slate-500">Reading the carrier configuration…</p>
          ) : (
            <>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div>
                  <span className={ui.label}>From</span>
                  <p className="mt-2 rounded-xl bg-slate-50 px-3.5 py-2.5 text-sm font-bold text-slate-700">
                    {senderAddress}
                  </p>
                </div>
                <div>
                  <label className={ui.label} htmlFor="submission-kind">
                    This submission is
                  </label>
                  <select
                    id="submission-kind"
                    className={ui.select}
                    value={kind}
                    onChange={(event) => setKind(event.target.value as SubmissionKind)}
                  >
                    {(Object.keys(KIND_LABELS) as SubmissionKind[]).map((value) => (
                      <option key={value} value={value}>
                        {KIND_LABELS[value]}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="mt-4">
                <label className={ui.label} htmlFor="submission-to">To</label>
                <input
                  id="submission-to"
                  className={ui.input}
                  value={to}
                  onChange={(event) => setTo(event.target.value)}
                  placeholder="submissions@carrier.com"
                />
              </div>

              <div className="mt-4">
                <label className={ui.label} htmlFor="submission-cc">CC (optional)</label>
                <input
                  id="submission-cc"
                  className={ui.input}
                  value={cc}
                  onChange={(event) => setCc(event.target.value)}
                />
              </div>

              <div className="mt-4">
                <label className={ui.label} htmlFor="submission-subject">Subject</label>
                <input
                  id="submission-subject"
                  className={ui.input}
                  value={subject}
                  onChange={(event) => setSubject(event.target.value)}
                />
              </div>

              <div className="mt-4">
                <label className={ui.label} htmlFor="submission-body">Message</label>
                <textarea
                  id="submission-body"
                  className={ui.textarea}
                  rows={14}
                  value={body}
                  onChange={(event) => setBody(event.target.value)}
                />
              </div>

              {unresolved.length > 0 ? (
                // A warning, never a block. An agent may legitimately want literal braces,
                // and refusing to send over a formatting guess would be presumptuous.
                <p className="mt-2 flex items-start gap-2 text-sm font-bold text-amber-700">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                  Unfilled placeholder{unresolved.length > 1 ? 's' : ''}: {unresolved.join(', ')}.
                  Known ones are {SUBMISSION_PLACEHOLDERS.join(', ')}.
                </p>
              ) : null}

              <div className="mt-6">
                <div className="flex items-center justify-between">
                  <span className={ui.sectionTitle}>Attachments</span>
                  <span className="text-xs font-black text-slate-400">
                    {attachments.length} selected · {formatFileSize(totalBytes)}
                  </span>
                </div>

                {detail.documents.length === 0 ? (
                  <p className="mt-3 text-sm font-semibold text-slate-500">
                    This quote has no documents yet. Generate the carrier application or upload files
                    on the Documents tab.
                  </p>
                ) : (
                  <ul className="mt-3 space-y-1.5">
                    {detail.documents.map((doc) => (
                      <li key={doc.id}>
                        <label className="flex cursor-pointer items-center gap-3 rounded-xl border border-slate-200 px-3.5 py-2.5 transition hover:bg-slate-50">
                          <input
                            type="checkbox"
                            className="h-4 w-4"
                            checked={selected.has(doc.id)}
                            onChange={() => toggle(doc.id)}
                          />
                          <Paperclip className="h-4 w-4 shrink-0 text-slate-400" />
                          <span className="min-w-0 flex-1 truncate text-sm font-bold text-slate-800">
                            {doc.file_name}
                          </span>
                          {doc.id === carrierApplication?.id ? (
                            <span className="shrink-0 rounded-full bg-[#eef3fb] px-2 py-0.5 text-[11px] font-black text-[#223f7a]">
                              This carrier
                            </span>
                          ) : null}
                          <span className="shrink-0 text-xs font-black text-slate-400">
                            {formatFileSize(doc.file_size)}
                          </span>
                        </label>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              {blockers.length > 0 ? (
                <ul className="mt-5 space-y-1.5 rounded-2xl bg-amber-50 px-4 py-3">
                  {blockers.map((reason) => (
                    <li key={reason} className="text-sm font-bold text-amber-800">
                      {reason}
                    </li>
                  ))}
                </ul>
              ) : null}

              {error ? (
                <p className="mt-4 rounded-2xl bg-rose-50 px-4 py-3 text-sm font-bold text-rose-800">
                  {error}
                </p>
              ) : null}
            </>
          )}
        </div>

        <footer className="flex items-center justify-end gap-2 border-t border-slate-100 px-6 py-4">
          <button type="button" className={ui.btnSecondary} onClick={onClose} disabled={sending}>
            Cancel
          </button>
          <button
            type="button"
            className={ui.btnPrimary}
            onClick={() => void submit()}
            disabled={sending || loading || blockers.length > 0}
          >
            {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            {sending ? 'Sending…' : 'Send submission'}
          </button>
        </footer>
      </div>
    </div>
  );
}
