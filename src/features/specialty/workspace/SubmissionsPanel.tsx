'use client';

/**
 * The Submissions tab.
 *
 * Spec: .kiro/specs/carrier-email-submission, Requirements 4, 8, 11, and the production
 * fix items 1, 2 and 7.
 *
 * THE RULE THIS TAB NOW FOLLOWS: NEVER HIDE, ALWAYS EXPLAIN.
 *
 * The first version gated the readiness panel on `can_send` and the Prepare Submission
 * button on `connected`, and rendered nothing when either was false. Every distinct cause
 * — an un-backfilled profile flag, a missing environment variable in the deployment, an
 * unconnected mailbox, an un-linked carrier, a carrier with email submission switched off
 * — produced one identical output: a blank panel. From inside the product there was no way
 * to tell "you are not permitted" from "this is broken".
 *
 * So every carrier on the quote is rendered whatever its state, the action is always
 * present and disabled with its reasons beside it, and the readiness card reports the four
 * account-level facts unconditionally. A user who cannot send should be able to read why
 * and know who to ask.
 *
 * Submission state remains history rather than a tick: a carrier may receive an initial
 * submission, loss runs two days later, and a revised application after an underwriter
 * asks a question. All three are rows.
 */

import {
  ChevronDown,
  ChevronRight,
  Mail,
  Paperclip,
  Send,
  Settings2,
  TriangleAlert,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { ui } from '../../nhwd-shared/ui';
import SubmissionReadinessCard from '../../carrier-submissions/SubmissionReadinessCard';
import {
  disconnectMailbox,
  getConnectionStatus,
  getSubmissionHistory,
  type ConnectionStatus,
} from '../../carrier-submissions/api';
import { accountBlockers, carrierBlockers, readinessSummary } from '../../carrier-submissions/readiness';
import type { CarrierSubmission, SubmissionDocument } from '../../carrier-submissions/types';
import { listMarkets } from '../market-directory/api';
import type { MarketDirectoryEntry } from '../market-directory/types';
import { carrierStatusLabel, carrierStatusTone, formatFileSize, formatRelative } from '../status';
import type { CarrierMarket, OpportunityDetail } from '../types';

import PrepareSubmissionDialog from './PrepareSubmissionDialog';
import { Badge } from './shared';

/** Deep link into Market Directory. `src/app/page.tsx` already reads these parameters. */
const MARKET_DIRECTORY_HREF = '/?module=user_admin&sub=ua_market_directory';

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
  profileNames?: Record<string, string>;
}) {
  const [status, setStatus] = useState<ConnectionStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [submissions, setSubmissions] = useState<CarrierSubmission[]>([]);
  const [documents, setDocuments] = useState<SubmissionDocument[]>([]);
  const [markets, setMarkets] = useState<Map<string, MarketDirectoryEntry> | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [composing, setComposing] = useState<CarrierMarket | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    // Three independent reads, settled independently. One failing must not blank the
    // other two — that coupling is how a single 500 used to erase the whole screen.
    const [connection, history, marketList] = await Promise.allSettled([
      getConnectionStatus(),
      getSubmissionHistory({ opportunityId: detail.opportunity.id }),
      listMarkets({ activeOnly: false }),
    ]);

    if (connection.status === 'fulfilled') {
      setStatus(connection.value);
      setStatusError(null);
    } else {
      setStatus(null);
      setStatusError(
        connection.reason instanceof Error ? connection.reason.message : 'Unknown error.',
      );
    }

    if (history.status === 'fulfilled') {
      setSubmissions(history.value.submissions);
      setDocuments(history.value.documents);
      setHistoryError(null);
    } else {
      setHistoryError(
        history.reason instanceof Error ? history.reason.message : 'Could not read the history.',
      );
    }

    // Markets are configuration, not permission. Failing to read them means "unknown",
    // which `carrierBlockers` deliberately treats as "do not accuse".
    setMarkets(
      marketList.status === 'fulfilled'
        ? new Map(marketList.value.map((entry) => [entry.id, entry]))
        : null,
    );
  }, [detail.opportunity.id]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const disconnect = useCallback(async () => {
    setBusy(true);
    try {
      await disconnectMailbox();
      await refresh();
    } catch (err) {
      setStatusError(err instanceof Error ? err.message : 'Could not disconnect the mailbox.');
    } finally {
      setBusy(false);
    }
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

  const connection = status?.connection ?? null;
  const account = useMemo(
    () =>
      accountBlockers({
        canSend: status?.can_send === true,
        providerConfigured: status?.readiness?.provider ?? status?.configured ?? false,
        encryptionConfigured: status?.readiness?.encryption ?? status?.configured ?? false,
        connectionStatus: connection?.status ?? null,
      }),
    [status, connection],
  );

  const quoteClosed = detail.opportunity.result !== null;
  const isManager = detail.is_manager;

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
      {/* Unconditional. This is the whole point of the fix. */}
      <SubmissionReadinessCard
        status={status}
        loadError={statusError}
        busy={busy}
        onDisconnect={() => void disconnect()}
      />

      {notice ? (
        <p className="rounded-2xl bg-emerald-50 px-4 py-3 text-sm font-bold text-emerald-800">{notice}</p>
      ) : null}
      {historyError ? (
        <p className="rounded-2xl bg-rose-50 px-4 py-3 text-sm font-bold text-rose-800">
          Could not read the submission history. {historyError}
        </p>
      ) : null}

      {detail.carrier_markets.length === 0 ? (
        <div className={ui.card}>
          <div className={ui.cardPad}>
            <p className="text-sm font-semibold text-slate-500">
              No carriers on this quote yet. Add one on the Carriers tab, then come back here to
              submit to it.
            </p>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          {detail.carrier_markets.map((market) => {
            const config = market.market_directory_id
              ? markets?.get(market.market_directory_id) ?? null
              : null;
            const marketLoaded = markets !== null && (config !== null || !market.market_directory_id);

            const carrier = carrierBlockers({
              marketLinked: market.market_directory_id !== null,
              emailSubmissionEnabled: config?.email_submission_enabled === true,
              submissionEmail: config?.submission_email ?? null,
              marketLoaded,
              quoteClosed,
            });

            const blockers = [...account, ...carrier];
            const ready = blockers.length === 0;
            const history = byCarrier.get(market.id) ?? [];
            const sent = history.filter((entry) => entry.status === 'sent');
            const latest = sent[0] ?? null;
            const isOpen = expanded.has(market.id);

            const application = detail.documents
              .filter((d) => d.category === 'generated_application' && d.carrier_market_id === market.id)
              .sort((a, b) => b.created_at.localeCompare(a.created_at))[0];

            return (
              <div key={market.id} className={ui.card}>
                <div className="px-5 py-4">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <button
                      type="button"
                      className="flex min-w-0 flex-1 items-start gap-3 text-left"
                      onClick={() => toggle(market.id)}
                      aria-expanded={isOpen}
                    >
                      {isOpen ? (
                        <ChevronDown className="mt-1 h-4 w-4 shrink-0 text-slate-400" />
                      ) : (
                        <ChevronRight className="mt-1 h-4 w-4 shrink-0 text-slate-400" />
                      )}
                      <div className="min-w-0">
                        <p className="truncate text-sm font-black text-slate-900">
                          {market.carrier_name}
                        </p>
                        <p
                          className={`mt-0.5 text-xs font-black ${
                            ready ? 'text-emerald-700' : 'text-amber-700'
                          }`}
                        >
                          {readinessSummary(blockers)}
                        </p>

                        {/* The three facts a user needs before they can trust the button. */}
                        <dl className="mt-2 space-y-0.5 text-xs font-semibold text-slate-500">
                          <div className="flex gap-2">
                            <dt className="w-28 shrink-0 text-slate-400">To</dt>
                            <dd className="min-w-0 break-all">
                              {config?.submission_email || (
                                <span className="text-rose-600">not set</span>
                              )}
                            </dd>
                          </div>
                          <div className="flex gap-2">
                            <dt className="w-28 shrink-0 text-slate-400">Email submission</dt>
                            <dd>
                              {!market.market_directory_id ? (
                                <span className="text-rose-600">carrier not linked</span>
                              ) : config?.email_submission_enabled ? (
                                'Enabled'
                              ) : marketLoaded ? (
                                <span className="text-rose-600">Disabled</span>
                              ) : (
                                '…'
                              )}
                            </dd>
                          </div>
                          <div className="flex gap-2">
                            <dt className="w-28 shrink-0 text-slate-400">Application</dt>
                            <dd>
                              {application ? (
                                'Ready'
                              ) : (
                                <span className="text-slate-500">
                                  not generated — you can still send without one
                                </span>
                              )}
                            </dd>
                          </div>
                          <div className="flex gap-2">
                            <dt className="w-28 shrink-0 text-slate-400">Submissions</dt>
                            <dd>
                              {sent.length === 0
                                ? 'None yet'
                                : `${sent.length} · last ${formatRelative(latest?.sent_at ?? null)} by ${senderName(latest?.submitted_by ?? '')}`}
                            </dd>
                          </div>
                        </dl>
                      </div>
                    </button>

                    <div className="flex shrink-0 flex-col items-start gap-2 sm:items-end">
                      <Badge tone={carrierStatusTone(market.status)}>
                        {carrierStatusLabel(market.status)}
                      </Badge>
                      <div className="flex flex-wrap gap-2">
                        {/* Always rendered. Disabled with its reasons below, never absent. */}
                        <button
                          type="button"
                          className={ui.btnSecondary}
                          onClick={() => setComposing(market)}
                          disabled={!ready}
                          title={ready ? undefined : blockers.map((b) => b.message).join(' ')}
                        >
                          <Send className="h-4 w-4" />
                          Prepare submission
                        </button>
                        {isManager && carrier.some((b) => b.managerFixable) ? (
                          <a className={ui.btnGhost} href={MARKET_DIRECTORY_HREF}>
                            <Settings2 className="h-4 w-4" />
                            Configure carrier
                          </a>
                        ) : null}
                      </div>
                    </div>
                  </div>

                  {blockers.length > 0 ? (
                    <ul className="mt-3 space-y-1.5 rounded-2xl bg-amber-50 px-4 py-3">
                      {blockers.map((blocker) => (
                        <li key={blocker.code} className="text-xs font-bold text-amber-900">
                          {blocker.message}{' '}
                          <span className="font-semibold text-amber-700">{blocker.remedy}</span>
                        </li>
                      ))}
                    </ul>
                  ) : null}
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

      {status?.can_send && connection === null ? (
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
