'use client';

/**
 * The Submissions tab.
 *
 * Spec: .kiro/specs/carrier-email-submission, Requirements 4, 8, 11.
 *
 * Submission state is history, not a tick. A carrier may receive an initial submission,
 * then loss runs two days later, then a revised application after an underwriter asks a
 * question — three separate emails, all of which someone may need to produce months later.
 * So every send is a row, and this tab reads them back in the order they happened.
 */

import { ChevronDown, ChevronRight, Mail, Paperclip, Send, TriangleAlert } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { ui } from '../../nhwd-shared/ui';
import EmailConnectionPanel from '../../carrier-submissions/EmailConnectionPanel';
import { getConnectionStatus, getSubmissionHistory, type ConnectionStatus } from '../../carrier-submissions/api';
import type { CarrierSubmission, SubmissionDocument } from '../../carrier-submissions/types';
import { carrierStatusLabel, carrierStatusTone, formatFileSize, formatRelative } from '../status';
import type { CarrierMarket, OpportunityDetail } from '../types';

import PrepareSubmissionDialog from './PrepareSubmissionDialog';
import { Badge, SectionCard } from './shared';

const KIND_LABELS: Record<string, string> = {
  initial: 'Initial submission',
  additional_documents: 'Additional documents',
  revised: 'Revised submission',
};

function formatSentAt(value: string | null): string {
  if (!value) return '—';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return '—';
  return parsed.toLocaleString('en-US', {
    month: '2-digit', day: '2-digit', year: 'numeric', hour: 'numeric', minute: '2-digit',
  });
}

export default function SubmissionsPanel({
  detail,
  profileNames,
}: {
  detail: OpportunityDetail;
  /** profile id → display name, so history can name a sender without another query. */
  profileNames?: Record<string, string>;
}) {
  const [status, setStatus] = useState<ConnectionStatus | null>(null);
  const [submissions, setSubmissions] = useState<CarrierSubmission[]>([]);
  const [documents, setDocuments] = useState<SubmissionDocument[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [composing, setComposing] = useState<CarrierMarket | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [connection, history] = await Promise.all([
        getConnectionStatus(),
        getSubmissionHistory({ opportunityId: detail.opportunity.id }),
      ]);
      setStatus(connection);
      setSubmissions(history.submissions);
      setDocuments(history.documents);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not read the submission history.');
    }
  }, [detail.opportunity.id]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const byCarrier = useMemo(() => {
    const grouped = new Map<string, CarrierSubmission[]>();
    for (const submission of submissions) {
      const list = grouped.get(submission.carrier_market_id) ?? [];
      list.push(submission);
      grouped.set(submission.carrier_market_id, list);
    }
    return grouped;
  }, [submissions]);

  const docsBySubmission = useMemo(() => {
    const grouped = new Map<string, SubmissionDocument[]>();
    for (const doc of documents) {
      const list = grouped.get(doc.submission_id) ?? [];
      list.push(doc);
      grouped.set(doc.submission_id, list);
    }
    return grouped;
  }, [documents]);

  const canSend = status?.can_send === true;
  const connection = status?.connection ?? null;
  const connected = connection !== null && connection.status === 'connected';

  const toggle = useCallback((id: string) => {
    setExpanded((previous) => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const senderName = useCallback(
    (id: string) => profileNames?.[id] ?? 'A teammate',
    [profileNames],
  );

  return (
    <div className="space-y-4">
      {canSend ? <EmailConnectionPanel /> : null}

      {notice ? (
        <p className="rounded-2xl bg-emerald-50 px-4 py-3 text-sm font-bold text-emerald-800">{notice}</p>
      ) : null}
      {error ? (
        <p className="rounded-2xl bg-rose-50 px-4 py-3 text-sm font-bold text-rose-800">{error}</p>
      ) : null}

      {detail.carrier_markets.length === 0 ? (
        <SectionCard title="Carrier submissions">
          <p className="text-sm font-semibold text-slate-500">
            Add a carrier on the Carriers tab before preparing a submission.
          </p>
        </SectionCard>
      ) : (
        <div className="space-y-3">
          {detail.carrier_markets.map((market) => {
            const history = byCarrier.get(market.id) ?? [];
            const sent = history.filter((entry) => entry.status === 'sent');
            const latest = sent[0] ?? null;
            const isOpen = expanded.has(market.id);

            return (
              <div key={market.id} className={ui.card}>
                <div className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
                  <button
                    type="button"
                    className="flex min-w-0 flex-1 items-center gap-3 text-left"
                    onClick={() => toggle(market.id)}
                    aria-expanded={isOpen}
                  >
                    {isOpen ? (
                      <ChevronDown className="h-4 w-4 shrink-0 text-slate-400" />
                    ) : (
                      <ChevronRight className="h-4 w-4 shrink-0 text-slate-400" />
                    )}
                    <div className="min-w-0">
                      <p className="truncate text-sm font-black text-slate-900">{market.carrier_name}</p>
                      <p className="mt-0.5 text-xs font-bold text-slate-500">
                        {sent.length === 0
                          ? 'Not submitted'
                          : `${sent.length} submission${sent.length === 1 ? '' : 's'} · last ${formatRelative(latest?.sent_at ?? null)} by ${senderName(latest?.submitted_by ?? '')}`}
                      </p>
                    </div>
                  </button>

                  <div className="flex shrink-0 items-center gap-2">
                    <Badge tone={carrierStatusTone(market.status)}>
                      {carrierStatusLabel(market.status)}
                    </Badge>
                    {canSend ? (
                      <button
                        type="button"
                        className={ui.btnSecondary}
                        onClick={() => setComposing(market)}
                        disabled={!connected}
                        title={connected ? undefined : 'Connect your mailbox first'}
                      >
                        <Send className="h-4 w-4" />
                        Prepare submission
                      </button>
                    ) : null}
                  </div>
                </div>

                {isOpen ? (
                  <div className="border-t border-slate-100 px-5 py-4">
                    {history.length === 0 ? (
                      <p className="text-sm font-semibold text-slate-500">
                        Nothing has been sent to this carrier yet.
                      </p>
                    ) : (
                      <ol className="space-y-3">
                        {history.map((submission) => {
                          const attachments = docsBySubmission.get(submission.id) ?? [];
                          const failed = submission.status === 'failed';
                          return (
                            <li
                              key={submission.id}
                              className={`rounded-2xl border px-4 py-3 ${
                                failed ? 'border-rose-200 bg-rose-50/40' : 'border-slate-200'
                              }`}
                            >
                              <div className="flex flex-wrap items-baseline justify-between gap-2">
                                <p className="text-sm font-black text-slate-900">
                                  {KIND_LABELS[submission.submission_kind] ?? submission.submission_kind}
                                  {failed ? (
                                    <span className="ml-2 inline-flex items-center gap-1 text-rose-700">
                                      <TriangleAlert className="h-3.5 w-3.5" /> Not sent
                                    </span>
                                  ) : null}
                                  {submission.status === 'sending' ? (
                                    <span className="ml-2 text-amber-700">In flight</span>
                                  ) : null}
                                </p>
                                <p className="text-xs font-bold text-slate-500">
                                  {formatSentAt(submission.sent_at ?? submission.created_at)} ·{' '}
                                  {senderName(submission.submitted_by)}
                                </p>
                              </div>

                              <dl className="mt-2 space-y-1 text-xs font-semibold text-slate-600">
                                <div className="flex gap-2">
                                  <dt className="w-14 shrink-0 text-slate-400">From</dt>
                                  <dd className="min-w-0 break-all">{submission.from_email}</dd>
                                </div>
                                <div className="flex gap-2">
                                  <dt className="w-14 shrink-0 text-slate-400">To</dt>
                                  <dd className="min-w-0 break-all">{submission.to_email.join(', ')}</dd>
                                </div>
                                {submission.cc_email.length > 0 ? (
                                  <div className="flex gap-2">
                                    <dt className="w-14 shrink-0 text-slate-400">CC</dt>
                                    <dd className="min-w-0 break-all">{submission.cc_email.join(', ')}</dd>
                                  </div>
                                ) : null}
                                <div className="flex gap-2">
                                  <dt className="w-14 shrink-0 text-slate-400">Subject</dt>
                                  <dd className="min-w-0">{submission.subject}</dd>
                                </div>
                              </dl>

                              {failed && submission.failure_reason ? (
                                <p className="mt-2 text-xs font-bold text-rose-700">
                                  {submission.failure_reason}
                                  {submission.failure_retryable ? ' This one is worth trying again.' : ''}
                                </p>
                              ) : null}

                              <details className="mt-2">
                                <summary className="cursor-pointer text-xs font-black text-[#223f7a]">
                                  Message as sent
                                </summary>
                                <pre className="mt-2 whitespace-pre-wrap rounded-xl bg-slate-50 px-3 py-2 text-xs font-semibold text-slate-700">
                                  {submission.body}
                                </pre>
                              </details>

                              {attachments.length > 0 ? (
                                <ul className="mt-2 space-y-1">
                                  {attachments.map((doc) => (
                                    <li
                                      key={doc.id}
                                      className="flex items-center gap-2 text-xs font-bold text-slate-600"
                                    >
                                      <Paperclip className="h-3.5 w-3.5 shrink-0 text-slate-400" />
                                      <span className="min-w-0 truncate">{doc.file_name}</span>
                                      <span className="shrink-0 text-slate-400">
                                        {formatFileSize(doc.file_size ?? 0)}
                                      </span>
                                      {doc.quote_document_id === null ? (
                                        // The snapshot outlives the file. Say so rather than
                                        // offering a link that goes nowhere.
                                        <span className="shrink-0 text-slate-400">
                                          — no longer on the quote
                                        </span>
                                      ) : null}
                                    </li>
                                  ))}
                                </ul>
                              ) : null}
                            </li>
                          );
                        })}
                      </ol>
                    )}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      )}

      {canSend && !connected ? (
        <p className="flex items-center gap-2 text-sm font-bold text-slate-500">
          <Mail className="h-4 w-4" />
          Connect your mailbox above to start sending submissions.
        </p>
      ) : null}

      {composing && connection ? (
        <PrepareSubmissionDialog
          detail={detail}
          market={composing}
          senderAddress={connection.email_address}
          onClose={() => setComposing(null)}
          onSent={(result) => {
            setComposing(null);
            setNotice(
              result.duplicate
                ? 'That submission had already been sent — nothing was sent twice.'
                : `Sent to ${result.sent_to.join(', ')}.`,
            );
            void refresh();
          }}
        />
      ) : null}
    </div>
  );
}
