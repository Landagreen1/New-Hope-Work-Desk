'use client';

/**
 * Carrier Submission Readiness — always visible, never hidden.
 *
 * Spec: carrier email submission production fix, item 1.
 *
 * WHY THIS EXISTS
 *   The first implementation rendered nothing at all unless `can_send` was true, and
 *   nothing again unless a mailbox was connected. Every distinct cause — a flag that was
 *   never backfilled, an environment variable missing from the deployment, a mailbox that
 *   was never connected, a request that failed — produced the same output: an empty
 *   panel. There was no way to tell them apart from inside the product.
 *
 *   So this card renders in every state and answers four questions plainly. Being told
 *   "sending is not enabled for your account" is a worse outcome than being able to send,
 *   and a far better one than a blank screen.
 */

import { AlertTriangle, CheckCircle2, Mail, Unplug, XCircle } from 'lucide-react';
import type { ReactNode } from 'react';

import { ui } from '../nhwd-shared/ui';

import { connectMailboxUrl, type ConnectionStatus } from './api';
import { accountBlockers } from './readiness';

function StateRow({ label, value, ok }: { label: string; value: ReactNode; ok: boolean | null }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-slate-100 py-2 last:border-b-0">
      <dt className="text-sm font-bold text-slate-500">{label}</dt>
      <dd className="flex items-center gap-1.5 text-sm font-black text-slate-900">
        {ok === null ? null : ok ? (
          <CheckCircle2 className="h-4 w-4 text-emerald-600" />
        ) : (
          <XCircle className="h-4 w-4 text-rose-500" />
        )}
        <span className={ok === false ? 'text-rose-700' : undefined}>{value}</span>
      </dd>
    </div>
  );
}

export default function SubmissionReadinessCard({
  status,
  loadError,
  busy,
  onDisconnect,
}: {
  /** Null while the first read is in flight, or when it failed. */
  status: ConnectionStatus | null;
  loadError: string | null;
  busy: boolean;
  onDisconnect: () => void;
}) {
  // A failed read is itself a state worth naming. Previously it was indistinguishable
  // from "you are not a sender", because both rendered nothing.
  if (loadError !== null) {
    return (
      <div className={ui.card}>
        <div className={ui.cardPad}>
          <h3 className="text-sm font-black text-slate-900">Carrier submission readiness</h3>
          <p className="mt-3 rounded-2xl bg-rose-50 px-4 py-3 text-sm font-bold text-rose-800">
            Could not read your submission settings. {loadError}
          </p>
          <p className="mt-3 text-xs font-semibold text-slate-400">
            This is a fault in the Work Desk, not a permission problem. Reload the page; if it
            persists, the deployment may be missing its email configuration.
          </p>
        </div>
      </div>
    );
  }

  if (status === null) {
    return (
      <div className={ui.card}>
        <div className={ui.cardPad}>
          <h3 className="text-sm font-black text-slate-900">Carrier submission readiness</h3>
          <p className="mt-2 text-sm font-semibold text-slate-500">Checking…</p>
        </div>
      </div>
    );
  }

  const connection = status.connection;
  const connected = connection !== null && connection.status === 'connected';
  const blockers = accountBlockers({
    canSend: status.can_send,
    providerConfigured: status.readiness?.provider ?? status.configured,
    encryptionConfigured: status.readiness?.encryption ?? status.configured,
    connectionStatus: connection?.status ?? null,
  });

  return (
    <div className={ui.card}>
      <div className={ui.cardPad}>
        <div className="flex items-start gap-3">
          <div className="grid h-10 w-10 shrink-0 place-items-center rounded-2xl bg-[#eef3fb] text-[#223f7a]">
            <Mail className="h-5 w-5" />
          </div>
          <div className="min-w-0">
            <h3 className="text-sm font-black text-slate-900">Carrier submission readiness</h3>
            <p className="mt-1 text-sm font-semibold text-slate-500">
              Submissions are sent from your own mailbox, so carrier replies come back to you.
            </p>
          </div>
        </div>

        <dl className="mt-4">
          <StateRow
            label="Email system configured"
            value={status.readiness?.ready ?? status.configured ? 'Yes' : 'No'}
            ok={status.readiness?.ready ?? status.configured}
          />
          <StateRow
            label="You are allowed to send"
            value={status.can_send ? 'Yes' : 'No'}
            ok={status.can_send}
          />
          <StateRow
            label="Mailbox connected"
            value={connected ? 'Yes' : connection ? 'Needs reconnection' : 'No'}
            ok={connected}
          />
          <StateRow
            label="Connected email"
            value={connection?.email_address ?? '—'}
            ok={connection ? true : null}
          />
        </dl>

        {blockers.length > 0 ? (
          <ul className="mt-4 space-y-2">
            {blockers.map((blocker) => (
              <li key={blocker.code} className="rounded-2xl bg-amber-50 px-4 py-3">
                <p className="flex items-start gap-2 text-sm font-black text-amber-900">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                  {blocker.message}
                </p>
                <p className="mt-1 pl-6 text-sm font-semibold text-amber-800">{blocker.remedy}</p>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-4 rounded-2xl bg-emerald-50 px-4 py-3 text-sm font-black text-emerald-800">
            Ready to send carrier submissions.
          </p>
        )}

        {/* Actions are offered whenever the account may send, even if the environment is
            not configured — the button explains itself by being disabled rather than by
            vanishing. */}
        {status.can_send ? (
          <div className="mt-5 flex flex-wrap gap-2">
            {connection === null ? (
              <a
                className={ui.btnPrimary}
                href={connectMailboxUrl()}
                aria-disabled={!(status.readiness?.ready ?? status.configured)}
                onClick={(event) => {
                  if (!(status.readiness?.ready ?? status.configured)) event.preventDefault();
                }}
              >
                <Mail className="h-4 w-4" />
                Connect Microsoft 365 mailbox
              </a>
            ) : (
              <>
                <a
                  className={connected ? ui.btnSecondary : ui.btnPrimary}
                  href={connectMailboxUrl(true)}
                >
                  Reconnect
                </a>
                <button type="button" className={ui.btnDanger} onClick={onDisconnect} disabled={busy}>
                  <Unplug className="h-4 w-4" />
                  Disconnect
                </button>
              </>
            )}
          </div>
        ) : null}

        <p className="mt-4 text-xs font-semibold leading-5 text-slate-400">
          The Work Desk asks Microsoft for permission to read and write your mail, to send mail as
          you, and to read your name. The read-and-write permission is what lets it compose the
          submission in your mailbox so the sent message and any carrier replies live in your own
          Sent Items and inbox. It reads nothing on its own and stores no copy of your mail, and
          your password is never stored.
        </p>
      </div>
    </div>
  );
}
