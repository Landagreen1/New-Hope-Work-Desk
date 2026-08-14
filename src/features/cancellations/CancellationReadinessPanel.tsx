'use client';

// Readiness panel for the automatic sending safety checks (REQ-3.2, REQ-3.3).
//
// Shows deployment readiness status, scheduler health, and the automatic sending toggle.
// Manager-only: calls POST /api/cancellations/readiness on mount.

import { AlertTriangle, CheckCircle2, LoaderCircle, Mail, RefreshCw, XCircle } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import { ui } from '../nhwd-shared/ui';

interface ReadinessReport {
  database: { migrated: boolean; settingsExists: boolean };
  sms: { configured: boolean };
  email: { configured: boolean };
  templates: { complete: boolean; missing: number[] };
  scheduler: { cronSecretSet: boolean; lastRun: string | null; lastResult: unknown | null };
  sending: { enabled: boolean; failedCount: number; missingContactCount: number };
}

export default function CancellationReadinessPanel() {
  const [report, setReport] = useState<ReadinessReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchReadiness = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch('/api/cancellations/readiness', { method: 'POST' });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${response.status}`);
      }
      setReport(await response.json());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to check readiness');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchReadiness(); }, [fetchReadiness]);

  if (loading && !report) {
    return (
      <div className="flex items-center gap-2 p-4 text-sm text-slate-500">
        <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" />
        Checking deployment readiness...
      </div>
    );
  }

  if (error && !report) {
    return (
      <div className={`${ui.error} flex items-center justify-between gap-3`}>
        <span>{error}</span>
        <button type="button" className={ui.btnSecondary} onClick={fetchReadiness}>
          <RefreshCw className="h-3 w-3" /> Retry
        </button>
      </div>
    );
  }

  if (!report) return null;

  const allReady =
    report.database.settingsExists &&
    report.sms.configured &&
    report.email.configured &&
    report.templates.complete &&
    report.scheduler.cronSecretSet;

  return (
    <div className="space-y-4 rounded-lg border border-slate-200 bg-white p-4">
      <div className="flex items-center justify-between">
        <h4 className="text-sm font-semibold text-slate-900">Deployment Readiness</h4>
        <button
          type="button"
          onClick={fetchReadiness}
          disabled={loading}
          className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
          aria-label="Refresh readiness check"
        >
          <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {/* Checklist */}
      <div className="space-y-2">
        <CheckItem label="Database & Settings" ok={report.database.settingsExists} />
        <CheckItem label="SMS Configuration (RingCentral)" ok={report.sms.configured} />
        <CheckItem label="Email Configuration (Resend)" ok={report.email.configured} />
        <CheckItem
          label="Templates (all 4 touchpoints)"
          ok={report.templates.complete}
          detail={report.templates.missing.length > 0 ? `Missing: ${report.templates.missing.join(', ')}-day` : undefined}
        />
        <CheckItem label="Scheduler (CRON_SECRET)" ok={report.scheduler.cronSecretSet} />
      </div>

      {/* Last run info */}
      <div className="rounded border border-slate-100 bg-slate-50 p-3 text-xs">
        <p className="font-medium text-slate-700">Last Scheduler Run</p>
        {report.scheduler.lastRun ? (
          <p className="mt-1 text-slate-600">
            Completed: {new Date(report.scheduler.lastRun).toLocaleString()}
          </p>
        ) : (
          <p className="mt-1 text-slate-500">No scheduler run recorded yet.</p>
        )}
      </div>

      {/* Sending status */}
      <div className="grid grid-cols-3 gap-2 text-center text-xs">
        <div className="rounded border border-slate-100 p-2">
          <p className={`text-lg font-bold ${report.sending.enabled ? 'text-green-600' : 'text-slate-400'}`}>
            {report.sending.enabled ? 'ON' : 'OFF'}
          </p>
          <p className="text-slate-500">Auto Send</p>
        </div>
        <div className="rounded border border-slate-100 p-2">
          <p className={`text-lg font-bold ${report.sending.failedCount > 0 ? 'text-red-600' : 'text-slate-700'}`}>
            {report.sending.failedCount}
          </p>
          <p className="text-slate-500">Failed</p>
        </div>
        <div className="rounded border border-slate-100 p-2">
          <p className={`text-lg font-bold ${report.sending.missingContactCount > 0 ? 'text-amber-600' : 'text-slate-700'}`}>
            {report.sending.missingContactCount}
          </p>
          <p className="text-slate-500">No Contact</p>
        </div>
      </div>

      <EmailConfigurationTest configured={report.email.configured} />

      {/* Activation gate */}
      {!allReady ? (
        <div className="flex items-start gap-2 rounded border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            Automatic sending cannot be activated until all readiness checks pass.
            Resolve the items marked with ✗ above.
          </span>
        </div>
      ) : !report.sending.enabled ? (
        <div className="flex items-start gap-2 rounded border border-green-200 bg-green-50 p-3 text-xs text-green-800">
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            All checks pass. Automatic sending may be activated from the settings panel.
          </span>
        </div>
      ) : null}
    </div>
  );
}

/**
 * The email configuration test.
 *
 * The tick above it reports only that the credentials are *present*. A revoked key, a from-address on
 * an unverified domain, and a domain still waiting on DNS all look identical from the environment, so
 * the tick can be green while every send fails. One real message is the only thing that tells them
 * apart, and the provider's own reason is reported verbatim because "domain is not verified" and
 * "API key is invalid" need different fixes.
 *
 * The recipient is typed by the manager and never read from the database, so this cannot reach a
 * customer. Nothing is written.
 */
function EmailConfigurationTest({ configured }: { configured: boolean }) {
  const [recipient, setRecipient] = useState('');
  const [sending, setSending] = useState(false);
  const [outcome, setOutcome] = useState<{ ok: boolean; message: string } | null>(null);

  async function send() {
    setSending(true);
    setOutcome(null);
    try {
      const response = await fetch('/api/cancellations/test-email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ recipient }),
      });
      const body = await response.json().catch(() => ({}));

      if (response.ok && body?.ok) {
        setOutcome({
          ok: true,
          message: `Sent to ${body.recipient}. Check that inbox, including its spam folder.`,
        });
      } else {
        setOutcome({
          ok: false,
          // The provider's reason first, because it names the fix.
          message: body?.failureReason || body?.error || `The send failed with HTTP ${response.status}.`,
        });
      }
    } catch (caught) {
      setOutcome({
        ok: false,
        message: caught instanceof Error ? caught.message : 'The test message could not be sent.',
      });
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="rounded border border-slate-100 bg-slate-50 p-3">
      <p className="text-xs font-medium text-slate-700">Email Configuration Test</p>
      <p className="mt-1 text-xs text-slate-500">
        Sends one message to an address you choose. No customer is contacted and nothing is recorded.
      </p>

      <div className="mt-2 flex flex-wrap items-end gap-2">
        <label className="min-w-[220px] flex-1">
          <span className="sr-only">Send the test message to</span>
          <input
            type="email"
            className={ui.input}
            placeholder="you@newhopeins.com"
            value={recipient}
            disabled={sending}
            onChange={(event) => setRecipient(event.target.value)}
          />
        </label>
        <button
          type="button"
          className={ui.btnSecondary}
          disabled={sending || recipient.trim().length === 0}
          onClick={() => void send()}
        >
          {sending ? (
            <>
              <LoaderCircle className="h-3 w-3 animate-spin" aria-hidden="true" /> Sending…
            </>
          ) : (
            <>
              <Mail className="h-3 w-3" aria-hidden="true" /> Send test email
            </>
          )}
        </button>
      </div>

      {!configured ? (
        <p className="mt-2 flex items-start gap-2 text-xs text-amber-800">
          <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
          Email is not configured yet, so this will be refused. Set the server environment variables
          and redeploy first.
        </p>
      ) : null}

      {outcome ? (
        <p
          role="status"
          className={`mt-2 flex items-start gap-2 text-xs ${outcome.ok ? 'text-green-700' : 'text-red-700'}`}
        >
          {outcome.ok ? (
            <CheckCircle2 className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
          ) : (
            <XCircle className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
          )}
          {outcome.message}
        </p>
      ) : null}
    </div>
  );
}

function CheckItem({ label, ok, detail }: { label: string; ok: boolean; detail?: string }) {
  return (
    <div className="flex items-center gap-2 text-sm">
      {ok ? (
        <CheckCircle2 className="h-4 w-4 text-green-500" aria-label="Ready" />
      ) : (
        <XCircle className="h-4 w-4 text-red-500" aria-label="Not ready" />
      )}
      <span className={ok ? 'text-slate-700' : 'text-red-700'}>{label}</span>
      {detail ? <span className="text-xs text-slate-500">({detail})</span> : null}
    </div>
  );
}
