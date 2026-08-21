'use client';

/**
 * Email Connection — connect, reconnect, disconnect.
 *
 * Spec: .kiro/specs/carrier-email-submission, Requirement 1.
 *
 * Shows the mailbox that was ACTUALLY authorised, read back from the provider, rather
 * than the one anyone assumed (Requirement 1.12). That address is what carriers will see
 * in the From line, so it is the only one worth displaying.
 */

import { AlertTriangle, CheckCircle2, Mail, Unplug } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import { ui } from '../nhwd-shared/ui';

import {
  connectMailboxUrl,
  disconnectMailbox,
  getConnectionStatus,
  type ConnectionStatus,
} from './api';

function formatDate(value: string | null): string {
  if (!value) return '—';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime())
    ? '—'
    : parsed.toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' });
}

export default function EmailConnectionPanel({ compact = false }: { compact?: boolean }) {
  const [status, setStatus] = useState<ConnectionStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<{ kind: 'connected' | 'error'; detail: string } | null>(null);

  const load = useCallback(async () => {
    try {
      setStatus(await getConnectionStatus());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not read the connection status.');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // The OAuth callback redirects back with the outcome in the query string, because a
  // provider round trip cannot return a value any other way.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    const result = params.get('email_connection');
    if (!result) return;
    setOutcome({
      kind: result === 'connected' ? 'connected' : 'error',
      detail: params.get('detail') ?? '',
    });
    // Clear it so a refresh does not re-announce a connection made minutes ago.
    params.delete('email_connection');
    params.delete('detail');
    const query = params.toString();
    window.history.replaceState({}, '', `${window.location.pathname}${query ? `?${query}` : ''}`);
  }, []);

  const disconnect = useCallback(async () => {
    setBusy(true);
    try {
      await disconnectMailbox();
      setOutcome(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not disconnect the mailbox.');
    } finally {
      setBusy(false);
    }
  }, [load]);

  if (status === null && error === null) {
    return <p className="text-sm font-semibold text-slate-500">Reading the connection…</p>;
  }

  if (status && !status.can_send) {
    // Not an error. Most people will never send submissions, and telling them their
    // account is broken would be wrong.
    return null;
  }

  const connection = status?.connection ?? null;
  const needsReconnect = connection?.status === 'needs_reconnect';

  return (
    <div className={compact ? '' : ui.card}>
      <div className={compact ? '' : ui.cardPad}>
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <div className="grid h-10 w-10 shrink-0 place-items-center rounded-2xl bg-[#eef3fb] text-[#223f7a]">
              <Mail className="h-5 w-5" />
            </div>
            <div>
              <h3 className="text-sm font-black text-slate-900">Email connection</h3>
              <p className="mt-1 text-sm font-semibold text-slate-500">
                Carrier submissions are sent from your own mailbox, so replies come back to you.
              </p>
            </div>
          </div>
        </div>

        {outcome ? (
          <div
            className={`mt-4 rounded-2xl px-4 py-3 text-sm font-bold ${
              outcome.kind === 'connected'
                ? 'bg-emerald-50 text-emerald-800'
                : 'bg-rose-50 text-rose-800'
            }`}
          >
            {outcome.kind === 'connected'
              ? `Connected ${outcome.detail}.`
              : `Could not connect. ${outcome.detail}`}
          </div>
        ) : null}

        {error ? (
          <div className="mt-4 rounded-2xl bg-rose-50 px-4 py-3 text-sm font-bold text-rose-800">
            {error}
          </div>
        ) : null}

        {status && !status.configured ? (
          <div className="mt-4 rounded-2xl bg-amber-50 px-4 py-3 text-sm font-bold text-amber-800">
            Email submission is not configured on the server yet. An administrator needs to add the
            Microsoft application settings and the token encryption key.
          </div>
        ) : null}

        <dl className="mt-5 grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div>
            <dt className={ui.statLabel}>Mailbox</dt>
            <dd className="mt-1 text-sm font-black text-slate-900">
              {connection?.email_address ?? 'Not connected'}
            </dd>
          </div>
          <div>
            <dt className={ui.statLabel}>Status</dt>
            <dd className="mt-1 flex items-center gap-1.5 text-sm font-black">
              {connection === null ? (
                <span className="text-slate-500">Not connected</span>
              ) : needsReconnect ? (
                <>
                  <AlertTriangle className="h-4 w-4 text-amber-600" />
                  <span className="text-amber-700">Needs reconnection</span>
                </>
              ) : (
                <>
                  <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                  <span className="text-emerald-700">Connected</span>
                </>
              )}
            </dd>
          </div>
          <div>
            <dt className={ui.statLabel}>Connected</dt>
            <dd className="mt-1 text-sm font-black text-slate-900">
              {formatDate(connection?.connected_at ?? null)}
            </dd>
          </div>
        </dl>

        {needsReconnect && connection?.last_error ? (
          <p className="mt-3 text-sm font-semibold text-amber-700">{connection.last_error}</p>
        ) : null}

        <div className="mt-5 flex flex-wrap gap-2">
          {connection === null ? (
            <a
              className={ui.btnPrimary}
              href={connectMailboxUrl()}
              aria-disabled={!status?.configured}
              onClick={(event) => {
                if (!status?.configured) event.preventDefault();
              }}
            >
              <Mail className="h-4 w-4" />
              Connect mailbox
            </a>
          ) : (
            <>
              <a className={needsReconnect ? ui.btnPrimary : ui.btnSecondary} href={connectMailboxUrl(true)}>
                Reconnect
              </a>
              <button type="button" className={ui.btnDanger} onClick={() => void disconnect()} disabled={busy}>
                <Unplug className="h-4 w-4" />
                Disconnect
              </button>
            </>
          )}
        </div>

        <p className="mt-4 text-xs font-semibold leading-5 text-slate-400">
          The Work Desk asks only for permission to send mail as you and to read your name. It
          cannot read your inbox. Your password is never stored.
        </p>
      </div>
    </div>
  );
}
