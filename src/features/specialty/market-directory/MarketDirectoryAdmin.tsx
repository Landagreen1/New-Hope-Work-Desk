'use client';

/**
 * Market Directory Administration
 *
 * Manager-only interface for managing the Market Directory: creating, editing,
 * activating/deactivating Markets, managing aliases, contacts, requirements,
 * and supplemental questions.
 *
 * Lives in the same settings area as QuotingTeamsAdmin.
 *
 * v1.17.0
 */

import { useCallback, useEffect, useState } from 'react';

import { formatRecipientList, parseRecipientList } from '@/features/carrier-submissions/recipients';
import { SUBMISSION_PLACEHOLDERS } from '@/features/carrier-submissions/templates';

import {
  addAlias,
  addContact,
  addQuestion,
  addRequirement,
  createMarket,
  listMarkets,
  removeAlias,
  removeContact,
  updateContact,
  updateMarket,
  updateQuestion,
  updateRequirement,
  type MarketContactPatch,
  type MarketDirectoryPatch,
} from './api';
import type {
  MarketContact,
  MarketDirectoryEntry,
  MarketQuestion,
  MarketRequirement,
  MarketType,
  QuestionFieldType,
  RequirementType,
} from './types';

const MARKET_TYPE_LABELS: Record<MarketType, string> = {
  direct_carrier: 'Direct Carrier',
  broker: 'Broker',
  mga: 'MGA',
  wholesaler: 'Wholesaler',
  program_administrator: 'Program Administrator',
  other: 'Other',
};

const LOB_OPTIONS = [
  { value: 'trucking', label: 'Trucking' },
  { value: 'homeowners', label: 'Homeowners' },
  { value: 'commercial_gl', label: 'Commercial GL' },
];

const FIELD_TYPE_LABELS: Record<QuestionFieldType, string> = {
  text: 'Text',
  long_text: 'Long Text',
  number: 'Number',
  currency: 'Currency',
  percentage: 'Percentage',
  date: 'Date',
  yes_no: 'Yes/No',
  select: 'Select',
};

const REQUIREMENT_TYPE_LABELS: Record<RequirementType, string> = {
  data: 'Data',
  document: 'Document',
  application: 'Application',
};

interface MarketDirectoryAdminProps {
  initialProfile: { id: string; role: string };
  embedded?: boolean;
}

export default function MarketDirectoryAdmin({ initialProfile, embedded = false }: MarketDirectoryAdminProps) {
  const isManager = initialProfile.role === 'manager' || initialProfile.role === 'super_admin';
  const [markets, setMarkets] = useState<MarketDirectoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedMarket, setSelectedMarket] = useState<MarketDirectoryEntry | null>(null);
  const [showInactive, setShowInactive] = useState(false);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [lobFilter, setLobFilter] = useState<string | null>(null);

  const loadMarkets = useCallback(async () => {
    setLoading(true);
    try {
      const data = await listMarkets({ activeOnly: !showInactive, lineOfBusiness: lobFilter });
      setMarkets(data);
    } catch (err) {
      console.error('Failed to load markets:', err);
    } finally {
      setLoading(false);
    }
  }, [showInactive, lobFilter]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadMarkets();
  }, [loadMarkets]);

  if (!isManager) {
    return (
      <div className="p-6 text-center text-zinc-500">
        Market Directory administration requires manager access.
      </div>
    );
  }

  return (
    <div className={embedded ? '' : 'p-6'}>
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-zinc-100">Market Directory</h2>
          <p className="text-sm text-zinc-400">
            Manage submission markets, contacts, requirements, and supplemental questions.
          </p>
        </div>
        <button
          onClick={() => setShowCreateForm(true)}
          className="rounded bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-500"
        >
          Add Market
        </button>
      </div>

      {/* Filters */}
      <div className="mb-4 flex items-center gap-3">
        <select
          value={lobFilter ?? ''}
          onChange={(e) => setLobFilter(e.target.value || null)}
          className="rounded border border-zinc-700 bg-zinc-800 px-2 py-1 text-sm text-zinc-200"
          aria-label="Filter by line of business"
        >
          <option value="">All Lines</option>
          {LOB_OPTIONS.map((lob) => (
            <option key={lob.value} value={lob.value}>{lob.label}</option>
          ))}
        </select>
        <label className="flex items-center gap-1.5 text-sm text-zinc-400">
          <input
            type="checkbox"
            checked={showInactive}
            onChange={(e) => setShowInactive(e.target.checked)}
            className="rounded"
          />
          Show inactive
        </label>
      </div>

      {/* Market List */}
      {loading ? (
        <div className="py-8 text-center text-zinc-500">Loading markets...</div>
      ) : markets.length === 0 ? (
        <div className="py-8 text-center text-zinc-500">No markets found.</div>
      ) : (
        <div className="space-y-1">
          {markets.map((market) => (
            <MarketRow
              key={market.id}
              market={market}
              isSelected={selectedMarket?.id === market.id}
              onSelect={() => setSelectedMarket(market)}
            />
          ))}
        </div>
      )}

      {/* Create Market Modal */}
      {showCreateForm && (
        <CreateMarketModal
          profileId={initialProfile.id}
          onClose={() => setShowCreateForm(false)}
          onCreated={() => { setShowCreateForm(false); loadMarkets(); }}
        />
      )}

      {/* Market Detail Drawer */}
      {selectedMarket && (
        <MarketDetailDrawer
          market={selectedMarket}
          onClose={() => setSelectedMarket(null)}
          onUpdated={loadMarkets}
        />
      )}
    </div>
  );
}

// ── Market Row ───────────────────────────────────────────────────────────────

function MarketRow({
  market,
  isSelected,
  onSelect,
}: {
  market: MarketDirectoryEntry;
  isSelected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      onClick={onSelect}
      className={`w-full rounded px-3 py-2 text-left transition ${
        isSelected
          ? 'bg-zinc-700 ring-1 ring-blue-500'
          : 'hover:bg-zinc-800'
      } ${!market.is_active ? 'opacity-50' : ''}`}
    >
      <div className="flex items-center justify-between">
        <div>
          <span className="font-medium text-zinc-100">{market.name}</span>
          <span className="ml-2 text-xs text-zinc-500">
            {MARKET_TYPE_LABELS[market.market_type]}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {market.lines_of_business.map((lob) => (
            <span key={lob} className="rounded bg-zinc-700 px-1.5 py-0.5 text-xs text-zinc-300">
              {lob}
            </span>
          ))}
          {!market.is_active && (
            <span className="rounded bg-red-900/50 px-1.5 py-0.5 text-xs text-red-300">
              Inactive
            </span>
          )}
        </div>
      </div>
      {market.aliases.length > 0 && (
        <div className="mt-0.5 text-xs text-zinc-500">
          Also: {market.aliases.map((a) => a.alias).join(', ')}
        </div>
      )}
    </button>
  );
}

// ── Create Market Modal ──────────────────────────────────────────────────────

function CreateMarketModal({
  profileId,
  onClose,
  onCreated,
}: {
  profileId: string;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [name, setName] = useState('');
  const [marketType, setMarketType] = useState<MarketType>('mga');
  const [lobs, setLobs] = useState<string[]>(['trucking']);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) { setError('Name is required'); return; }
    setSaving(true);
    setError('');
    try {
      await createMarket(
        { name: name.trim(), market_type: marketType, lines_of_business: lobs },
        profileId,
      );
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create market');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <form
        onClick={(e) => e.stopPropagation()}
        onSubmit={handleSubmit}
        className="w-full max-w-md rounded-lg bg-zinc-900 p-6 shadow-xl"
      >
        <h3 className="mb-4 text-lg font-semibold text-zinc-100">Add Market</h3>

        <label className="mb-3 block">
          <span className="text-sm text-zinc-400">Market Name</span>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="mt-1 w-full rounded border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-100"
            autoFocus
          />
        </label>

        <label className="mb-3 block">
          <span className="text-sm text-zinc-400">Market Type</span>
          <select
            value={marketType}
            onChange={(e) => setMarketType(e.target.value as MarketType)}
            className="mt-1 w-full rounded border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-100"
          >
            {Object.entries(MARKET_TYPE_LABELS).map(([k, v]) => (
              <option key={k} value={k}>{v}</option>
            ))}
          </select>
        </label>

        <fieldset className="mb-4">
          <legend className="text-sm text-zinc-400">Lines of Business</legend>
          <div className="mt-1 flex gap-3">
            {LOB_OPTIONS.map((lob) => (
              <label key={lob.value} className="flex items-center gap-1.5 text-sm text-zinc-300">
                <input
                  type="checkbox"
                  checked={lobs.includes(lob.value)}
                  onChange={(e) =>
                    setLobs(
                      e.target.checked
                        ? [...lobs, lob.value]
                        : lobs.filter((l) => l !== lob.value),
                    )
                  }
                  className="rounded"
                />
                {lob.label}
              </label>
            ))}
          </div>
        </fieldset>

        {error && <p className="mb-3 text-sm text-red-400">{error}</p>}

        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded px-3 py-1.5 text-sm text-zinc-400 hover:text-zinc-200">
            Cancel
          </button>
          <button
            type="submit"
            disabled={saving}
            className="rounded bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50"
          >
            {saving ? 'Creating...' : 'Create Market'}
          </button>
        </div>
      </form>
    </div>
  );
}

// ── Market Detail Drawer ─────────────────────────────────────────────────────

function MarketDetailDrawer({
  market,
  onClose,
  onUpdated,
}: {
  market: MarketDirectoryEntry;
  onClose: () => void;
  onUpdated: () => void;
}) {
  const [tab, setTab] = useState<'info' | 'submission' | 'aliases' | 'contacts' | 'requirements' | 'questions'>('info');

  return (
    <div className="fixed inset-y-0 right-0 z-40 w-full max-w-2xl overflow-y-auto bg-zinc-900 shadow-2xl">
      <div className="sticky top-0 z-10 flex items-center justify-between border-b border-zinc-800 bg-zinc-900 px-6 py-4">
        <div>
          <h3 className="text-lg font-semibold text-zinc-100">{market.name}</h3>
          <span className="text-sm text-zinc-500">{MARKET_TYPE_LABELS[market.market_type]}</span>
        </div>
        <button onClick={onClose} className="text-zinc-400 hover:text-zinc-200" aria-label="Close">
          ✕
        </button>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-zinc-800 px-6">
        {(['info', 'submission', 'aliases', 'contacts', 'requirements', 'questions'] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`border-b-2 px-3 py-2 text-sm font-medium capitalize transition ${
              tab === t
                ? 'border-blue-500 text-blue-400'
                : 'border-transparent text-zinc-500 hover:text-zinc-300'
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      <div className="p-6">
        {tab === 'info' && (
          <MarketInfoTab market={market} onUpdated={onUpdated} />
        )}
        {tab === 'submission' && (
          <SubmissionTab market={market} onUpdated={onUpdated} />
        )}
        {tab === 'aliases' && (
          <AliasesTab market={market} onUpdated={onUpdated} />
        )}
        {tab === 'contacts' && (
          <ContactsTab market={market} onUpdated={onUpdated} />
        )}
        {tab === 'requirements' && (
          <RequirementsTab market={market} />
        )}
        {tab === 'questions' && (
          <QuestionsTab market={market} />
        )}
      </div>
    </div>
  );
}

// ── Info Tab ─────────────────────────────────────────────────────────────────

function MarketInfoTab({ market, onUpdated }: { market: MarketDirectoryEntry; onUpdated: () => void }) {
  const [editing, setEditing] = useState(false);
  const [patch, setPatch] = useState<MarketDirectoryPatch>({});
  const [saving, setSaving] = useState(false);

  const startEdit = () => {
    setPatch({
      name: market.name,
      market_type: market.market_type,
      lines_of_business: market.lines_of_business,
      is_active: market.is_active,
      website_url: market.website_url,
      portal_url: market.portal_url,
      submission_email: market.submission_email,
      phone: market.phone,
      submission_instructions: market.submission_instructions,
      territory_notes: market.territory_notes,
      equipment_notes: market.equipment_notes,
      new_venture_notes: market.new_venture_notes,
      coverage_appetite: market.coverage_appetite,
      underwriting_notes: market.underwriting_notes,
    });
    setEditing(true);
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await updateMarket(market.id, patch);
      onUpdated();
      setEditing(false);
    } catch (err) {
      console.error('Failed to update market:', err);
    } finally {
      setSaving(false);
    }
  };

  if (!editing) {
    return (
      <div className="space-y-4">
        <div className="flex justify-end">
          <button onClick={startEdit} className="rounded bg-zinc-700 px-3 py-1 text-sm text-zinc-200 hover:bg-zinc-600">
            Edit
          </button>
        </div>
        <InfoRow label="Status" value={market.is_active ? 'Active' : 'Inactive'} />
        <InfoRow label="Type" value={MARKET_TYPE_LABELS[market.market_type]} />
        <InfoRow label="Lines" value={market.lines_of_business.join(', ')} />
        <InfoRow label="Website" value={market.website_url} />
        <InfoRow label="Portal URL" value={market.portal_url} />
        <InfoRow label="Submission Email" value={market.submission_email} />
        <InfoRow label="Phone" value={market.phone} />
        <InfoRow label="Submission Instructions" value={market.submission_instructions} multiline />
        <InfoRow label="Territory Notes" value={market.territory_notes} multiline />
        <InfoRow label="Equipment Notes" value={market.equipment_notes} multiline />
        <InfoRow label="New Venture Notes" value={market.new_venture_notes} multiline />
        <InfoRow label="Coverage Appetite" value={market.coverage_appetite} multiline />
        <InfoRow label="Underwriting Notes" value={market.underwriting_notes} multiline />
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <EditField label="Name" value={patch.name ?? ''} onChange={(v) => setPatch({ ...patch, name: v })} />
      <label className="block">
        <span className="text-sm text-zinc-400">Market Type</span>
        <select
          value={patch.market_type ?? market.market_type}
          onChange={(e) => setPatch({ ...patch, market_type: e.target.value })}
          className="mt-1 w-full rounded border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-100"
        >
          {Object.entries(MARKET_TYPE_LABELS).map(([k, v]) => (
            <option key={k} value={k}>{v}</option>
          ))}
        </select>
      </label>
      <label className="flex items-center gap-2 text-sm text-zinc-300">
        <input
          type="checkbox"
          checked={patch.is_active ?? market.is_active}
          onChange={(e) => setPatch({ ...patch, is_active: e.target.checked })}
          className="rounded"
        />
        Active
      </label>
      <EditField label="Website" value={patch.website_url ?? ''} onChange={(v) => setPatch({ ...patch, website_url: v || null })} />
      <EditField label="Portal URL" value={patch.portal_url ?? ''} onChange={(v) => setPatch({ ...patch, portal_url: v || null })} />
      <EditField label="Submission Email" value={patch.submission_email ?? ''} onChange={(v) => setPatch({ ...patch, submission_email: v || null })} />
      <EditField label="Phone" value={patch.phone ?? ''} onChange={(v) => setPatch({ ...patch, phone: v || null })} />
      <EditTextArea label="Submission Instructions" value={patch.submission_instructions ?? ''} onChange={(v) => setPatch({ ...patch, submission_instructions: v || null })} />
      <EditTextArea label="Territory Notes" value={patch.territory_notes ?? ''} onChange={(v) => setPatch({ ...patch, territory_notes: v || null })} />
      <EditTextArea label="Equipment Notes" value={patch.equipment_notes ?? ''} onChange={(v) => setPatch({ ...patch, equipment_notes: v || null })} />
      <EditTextArea label="New Venture Notes" value={patch.new_venture_notes ?? ''} onChange={(v) => setPatch({ ...patch, new_venture_notes: v || null })} />
      <EditTextArea label="Coverage Appetite" value={patch.coverage_appetite ?? ''} onChange={(v) => setPatch({ ...patch, coverage_appetite: v || null })} />
      <EditTextArea label="Underwriting Notes" value={patch.underwriting_notes ?? ''} onChange={(v) => setPatch({ ...patch, underwriting_notes: v || null })} />

      <div className="flex justify-end gap-2 pt-2">
        <button onClick={() => setEditing(false)} className="rounded px-3 py-1.5 text-sm text-zinc-400 hover:text-zinc-200">
          Cancel
        </button>
        <button
          onClick={handleSave}
          disabled={saving}
          className="rounded bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50"
        >
          {saving ? 'Saving...' : 'Save'}
        </button>
      </div>
    </div>
  );
}

// ── Submission Tab ───────────────────────────────────────────────────────────
//
// Spec: .kiro/specs/carrier-email-submission, Requirement 2.
//
// Its own tab rather than four more rows on the Info tab, which already carries
// thirteen fields. `submission_email` lives on both: it is read-only context here and
// editable there, because it predates this feature (v1.17.0) and managers already know
// where to find it.
//
// Errors surface in the UI rather than going to console.error as the Info tab does. A
// manager who mistypes a template and sees nothing happen has no way to tell a failed
// save from a successful one.

function SubmissionTab({ market, onUpdated }: { market: MarketDirectoryEntry; onUpdated: () => void }) {
  const [enabled, setEnabled] = useState(market.email_submission_enabled);
  const [ccText, setCcText] = useState(formatRecipientList(market.submission_cc));
  const [subject, setSubject] = useState(market.submission_subject_template ?? '');
  const [body, setBody] = useState(market.submission_body_template ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const cc = parseRecipientList(ccText);
  const hasAddress = (market.submission_email ?? '').trim().length > 0;

  // Requirement 2.7: enabling a market with nowhere to send is a configuration error
  // that would only surface as a failed send, in front of a customer.
  const blocking =
    enabled && !hasAddress
      ? 'Set a Submission Email on the Info tab before enabling email submission.'
      : cc.invalid.length > 0
        ? `Not a valid address: ${cc.invalid.join(', ')}`
        : null;

  const handleSave = async () => {
    if (blocking) return;
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      await updateMarket(market.id, {
        email_submission_enabled: enabled,
        submission_cc: cc.valid,
        submission_subject_template: subject.trim() || null,
        submission_body_template: body.trim() || null,
      });
      onUpdated();
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the submission settings.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      <label className="flex items-start gap-2 text-sm text-zinc-300">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => { setEnabled(e.target.checked); setSaved(false); }}
          className="mt-0.5 rounded"
        />
        <span>
          Submit to this market by email
          <span className="mt-0.5 block text-xs text-zinc-500">
            When off, Prepare Submission is unavailable for this carrier.
          </span>
        </span>
      </label>

      <InfoRow label="Submission Email" value={market.submission_email} />
      {!hasAddress && (
        <p className="text-xs text-amber-400">
          No submission address is set. Add one on the Info tab.
        </p>
      )}

      <label className="block">
        <span className="text-sm text-zinc-400">CC</span>
        <input
          value={ccText}
          onChange={(e) => { setCcText(e.target.value); setSaved(false); }}
          placeholder="underwriting@carrier.com, submissions@carrier.com"
          className="mt-1 w-full rounded border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-100"
        />
        <span className="mt-1 block text-xs text-zinc-500">
          Separate with commas, semicolons or spaces. Copied on every submission to this market.
        </span>
      </label>

      <EditTextArea
        label="Subject template"
        value={subject}
        onChange={(v) => { setSubject(v); setSaved(false); }}
      />
      <EditTextArea
        label="Body template"
        value={body}
        onChange={(v) => { setBody(v); setSaved(false); }}
      />
      <p className="text-xs text-zinc-500">
        Leave either blank to use the standard message.
      </p>

      <div className="rounded border border-zinc-800 bg-zinc-950 p-3">
        <p className="text-xs font-semibold uppercase tracking-wide text-zinc-400">Placeholders</p>
        <dl className="mt-2 space-y-1">
          {SUBMISSION_PLACEHOLDERS.map((placeholder) => (
            <div key={placeholder.token} className="flex gap-2 text-xs">
              <dt className="shrink-0 font-mono text-blue-400">{placeholder.token}</dt>
              <dd className="text-zinc-500">{placeholder.description}</dd>
            </div>
          ))}
        </dl>
      </div>

      {blocking && <p className="text-sm text-amber-400">{blocking}</p>}
      {error && <p className="text-sm text-rose-400">{error}</p>}
      {saved && !error && <p className="text-sm text-emerald-400">Saved.</p>}

      <div className="flex justify-end pt-1">
        <button
          onClick={handleSave}
          disabled={saving || blocking !== null}
          className="rounded bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50"
        >
          {saving ? 'Saving...' : 'Save'}
        </button>
      </div>
    </div>
  );
}

// ── Aliases Tab ──────────────────────────────────────────────────────────────

function AliasesTab({ market, onUpdated }: { market: MarketDirectoryEntry; onUpdated: () => void }) {
  const [newAlias, setNewAlias] = useState('');
  const [saving, setSaving] = useState(false);

  const handleAdd = async () => {
    if (!newAlias.trim()) return;
    setSaving(true);
    try {
      await addAlias(market.id, newAlias.trim());
      setNewAlias('');
      onUpdated();
    } catch (err) {
      console.error('Failed to add alias:', err);
    } finally {
      setSaving(false);
    }
  };

  const handleRemove = async (aliasId: string) => {
    try {
      await removeAlias(aliasId);
      onUpdated();
    } catch (err) {
      console.error('Failed to remove alias:', err);
    }
  };

  return (
    <div>
      <p className="mb-3 text-sm text-zinc-500">
        Alternative names/spellings that resolve to this market. Historical data and searches
        will match against these aliases.
      </p>

      {market.aliases.length > 0 && (
        <div className="mb-4 space-y-1">
          {market.aliases.map((alias) => (
            <div key={alias.id} className="flex items-center justify-between rounded bg-zinc-800 px-3 py-1.5">
              <span className="text-sm text-zinc-200">{alias.alias}</span>
              <button
                onClick={() => handleRemove(alias.id)}
                className="text-xs text-red-400 hover:text-red-300"
              >
                Remove
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="flex gap-2">
        <input
          type="text"
          value={newAlias}
          onChange={(e) => setNewAlias(e.target.value)}
          placeholder="Add alias..."
          className="flex-1 rounded border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-sm text-zinc-100"
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleAdd(); } }}
        />
        <button
          onClick={handleAdd}
          disabled={saving || !newAlias.trim()}
          className="rounded bg-zinc-700 px-3 py-1.5 text-sm text-zinc-200 hover:bg-zinc-600 disabled:opacity-50"
        >
          Add
        </button>
      </div>
    </div>
  );
}

// ── Contacts Tab ─────────────────────────────────────────────────────────────

function ContactsTab({ market, onUpdated }: { market: MarketDirectoryEntry; onUpdated: () => void }) {
  const [showAdd, setShowAdd] = useState(false);
  const [newContact, setNewContact] = useState<MarketContactPatch & { name: string }>({ name: '' });
  const [saving, setSaving] = useState(false);

  const handleAdd = async () => {
    if (!newContact.name.trim()) return;
    setSaving(true);
    try {
      await addContact(market.id, { ...newContact, name: newContact.name.trim() });
      setNewContact({ name: '' });
      setShowAdd(false);
      onUpdated();
    } catch (err) {
      console.error('Failed to add contact:', err);
    } finally {
      setSaving(false);
    }
  };

  const handleToggleActive = async (contact: MarketContact) => {
    try {
      await updateContact(contact.id, { is_active: !contact.is_active });
      onUpdated();
    } catch (err) {
      console.error('Failed to update contact:', err);
    }
  };

  const handleRemoveContact = async (contactId: string) => {
    try {
      await removeContact(contactId);
      onUpdated();
    } catch (err) {
      console.error('Failed to remove contact:', err);
    }
  };

  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <p className="text-sm text-zinc-500">Named contacts at this market.</p>
        <button
          onClick={() => setShowAdd(true)}
          className="rounded bg-zinc-700 px-2 py-1 text-xs text-zinc-200 hover:bg-zinc-600"
        >
          Add Contact
        </button>
      </div>

      {market.contacts.length > 0 && (
        <div className="mb-4 space-y-2">
          {market.contacts.map((contact) => (
            <div key={contact.id} className={`rounded bg-zinc-800 px-3 py-2 ${!contact.is_active ? 'opacity-50' : ''}`}>
              <div className="flex items-center justify-between">
                <div>
                  <span className="font-medium text-zinc-200">{contact.name}</span>
                  {contact.title && <span className="ml-2 text-xs text-zinc-500">{contact.title}</span>}
                  {contact.is_primary && <span className="ml-2 text-xs text-blue-400">Primary</span>}
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={() => handleToggleActive(contact)}
                    className="text-xs text-zinc-400 hover:text-zinc-200"
                  >
                    {contact.is_active ? 'Deactivate' : 'Activate'}
                  </button>
                  <button
                    onClick={() => handleRemoveContact(contact.id)}
                    className="text-xs text-red-400 hover:text-red-300"
                  >
                    Remove
                  </button>
                </div>
              </div>
              {(contact.email || contact.phone) && (
                <div className="mt-1 text-xs text-zinc-500">
                  {contact.email && <span className="mr-3">{contact.email}</span>}
                  {contact.phone && <span>{contact.phone}</span>}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {showAdd && (
        <div className="rounded border border-zinc-700 bg-zinc-800/50 p-3">
          <div className="grid grid-cols-2 gap-2">
            <EditField label="Name" value={newContact.name} onChange={(v) => setNewContact({ ...newContact, name: v })} />
            <EditField label="Title" value={newContact.title ?? ''} onChange={(v) => setNewContact({ ...newContact, title: v || null })} />
            <EditField label="Email" value={newContact.email ?? ''} onChange={(v) => setNewContact({ ...newContact, email: v || null })} />
            <EditField label="Phone" value={newContact.phone ?? ''} onChange={(v) => setNewContact({ ...newContact, phone: v || null })} />
          </div>
          <div className="mt-3 flex justify-end gap-2">
            <button onClick={() => setShowAdd(false)} className="text-sm text-zinc-400">Cancel</button>
            <button
              onClick={handleAdd}
              disabled={saving || !newContact.name.trim()}
              className="rounded bg-blue-600 px-3 py-1 text-sm text-white hover:bg-blue-500 disabled:opacity-50"
            >
              {saving ? 'Saving...' : 'Add'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Requirements Tab ─────────────────────────────────────────────────────────

function RequirementsTab({ market }: { market: MarketDirectoryEntry }) {
  const [lob, setLob] = useState('trucking');
  const [requirements, setRequirements] = useState<MarketRequirement[]>([]);
  const [loading, setLoading] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [newReq, setNewReq] = useState({ label: '', requirement_type: 'data' as string, description: '', is_required: true });

  const loadReqs = useCallback(async () => {
    setLoading(true);
    try {
      const { listRequirements: listReqs } = await import('./api');
      const data = await listReqs(market.id, lob);
      setRequirements(data);
    } catch (err) {
      console.error('Failed to load requirements:', err);
    } finally {
      setLoading(false);
    }
  }, [market.id, lob]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadReqs();
  }, [loadReqs]);

  const handleAdd = async () => {
    if (!newReq.label.trim()) return;
    try {
      await addRequirement(market.id, lob, {
        label: newReq.label.trim(),
        requirement_type: newReq.requirement_type,
        description: newReq.description || null,
        is_required: newReq.is_required,
      });
      setNewReq({ label: '', requirement_type: 'data', description: '', is_required: true });
      setShowAdd(false);
      loadReqs();
    } catch (err) {
      console.error('Failed to add requirement:', err);
    }
  };

  const handleDeactivate = async (reqId: string) => {
    try {
      await updateRequirement(reqId, { is_active: false });
      loadReqs();
    } catch (err) {
      console.error('Failed to deactivate requirement:', err);
    }
  };

  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <select
          value={lob}
          onChange={(e) => setLob(e.target.value)}
          className="rounded border border-zinc-700 bg-zinc-800 px-2 py-1 text-sm text-zinc-200"
          aria-label="Line of business"
        >
          {LOB_OPTIONS.filter((o) => market.lines_of_business.includes(o.value)).map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
        <button
          onClick={() => setShowAdd(true)}
          className="rounded bg-zinc-700 px-2 py-1 text-xs text-zinc-200 hover:bg-zinc-600"
        >
          Add Requirement
        </button>
      </div>

      {loading ? (
        <div className="py-4 text-center text-sm text-zinc-500">Loading...</div>
      ) : requirements.length === 0 ? (
        <div className="py-4 text-center text-sm text-zinc-500">No requirements configured for this LOB.</div>
      ) : (
        <div className="space-y-1">
          {requirements.map((req) => (
            <div key={req.id} className="flex items-center justify-between rounded bg-zinc-800 px-3 py-2">
              <div>
                <span className="text-sm text-zinc-200">{req.label}</span>
                <span className="ml-2 text-xs text-zinc-500">
                  {REQUIREMENT_TYPE_LABELS[req.requirement_type as RequirementType]}
                </span>
                {req.is_required && <span className="ml-1 text-xs text-amber-400">Required</span>}
              </div>
              <button
                onClick={() => handleDeactivate(req.id)}
                className="text-xs text-zinc-400 hover:text-red-400"
              >
                Deactivate
              </button>
            </div>
          ))}
        </div>
      )}

      {showAdd && (
        <div className="mt-3 rounded border border-zinc-700 bg-zinc-800/50 p-3">
          <div className="space-y-2">
            <EditField label="Label" value={newReq.label} onChange={(v) => setNewReq({ ...newReq, label: v })} />
            <label className="block">
              <span className="text-sm text-zinc-400">Type</span>
              <select
                value={newReq.requirement_type}
                onChange={(e) => setNewReq({ ...newReq, requirement_type: e.target.value })}
                className="mt-1 w-full rounded border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-100"
              >
                {Object.entries(REQUIREMENT_TYPE_LABELS).map(([k, v]) => (
                  <option key={k} value={k}>{v}</option>
                ))}
              </select>
            </label>
            <EditField label="Description" value={newReq.description} onChange={(v) => setNewReq({ ...newReq, description: v })} />
            <label className="flex items-center gap-2 text-sm text-zinc-300">
              <input
                type="checkbox"
                checked={newReq.is_required}
                onChange={(e) => setNewReq({ ...newReq, is_required: e.target.checked })}
                className="rounded"
              />
              Required for submission
            </label>
          </div>
          <div className="mt-3 flex justify-end gap-2">
            <button onClick={() => setShowAdd(false)} className="text-sm text-zinc-400">Cancel</button>
            <button onClick={handleAdd} disabled={!newReq.label.trim()} className="rounded bg-blue-600 px-3 py-1 text-sm text-white hover:bg-blue-500 disabled:opacity-50">
              Add
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Questions Tab ────────────────────────────────────────────────────────────

function QuestionsTab({ market }: { market: MarketDirectoryEntry }) {
  const [lob, setLob] = useState('trucking');
  const [questions, setQuestions] = useState<MarketQuestion[]>([]);
  const [loading, setLoading] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [newQ, setNewQ] = useState({ question_text: '', field_type: 'text' as string, is_required: false });

  const loadQs = useCallback(async () => {
    setLoading(true);
    try {
      const { listQuestions: listQs } = await import('./api');
      const data = await listQs(market.id, lob);
      setQuestions(data);
    } catch (err) {
      console.error('Failed to load questions:', err);
    } finally {
      setLoading(false);
    }
  }, [market.id, lob]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadQs();
  }, [loadQs]);

  const handleAdd = async () => {
    if (!newQ.question_text.trim()) return;
    try {
      await addQuestion(market.id, lob, {
        question_text: newQ.question_text.trim(),
        field_type: newQ.field_type,
        is_required: newQ.is_required,
      });
      setNewQ({ question_text: '', field_type: 'text', is_required: false });
      setShowAdd(false);
      loadQs();
    } catch (err) {
      console.error('Failed to add question:', err);
    }
  };

  const handleDeactivate = async (qId: string) => {
    try {
      await updateQuestion(qId, { is_active: false });
      loadQs();
    } catch (err) {
      console.error('Failed to deactivate question:', err);
    }
  };

  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <select
          value={lob}
          onChange={(e) => setLob(e.target.value)}
          className="rounded border border-zinc-700 bg-zinc-800 px-2 py-1 text-sm text-zinc-200"
          aria-label="Line of business"
        >
          {LOB_OPTIONS.filter((o) => market.lines_of_business.includes(o.value)).map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
        <button
          onClick={() => setShowAdd(true)}
          className="rounded bg-zinc-700 px-2 py-1 text-xs text-zinc-200 hover:bg-zinc-600"
        >
          Add Question
        </button>
      </div>

      {loading ? (
        <div className="py-4 text-center text-sm text-zinc-500">Loading...</div>
      ) : questions.length === 0 ? (
        <div className="py-4 text-center text-sm text-zinc-500">No supplemental questions configured for this LOB.</div>
      ) : (
        <div className="space-y-1">
          {questions.map((q) => (
            <div key={q.id} className="flex items-center justify-between rounded bg-zinc-800 px-3 py-2">
              <div>
                <span className="text-sm text-zinc-200">{q.question_text}</span>
                <span className="ml-2 text-xs text-zinc-500">
                  {FIELD_TYPE_LABELS[q.field_type as QuestionFieldType]}
                </span>
                {q.is_required && <span className="ml-1 text-xs text-amber-400">Required</span>}
              </div>
              <button
                onClick={() => handleDeactivate(q.id)}
                className="text-xs text-zinc-400 hover:text-red-400"
              >
                Deactivate
              </button>
            </div>
          ))}
        </div>
      )}

      {showAdd && (
        <div className="mt-3 rounded border border-zinc-700 bg-zinc-800/50 p-3">
          <div className="space-y-2">
            <EditField label="Question" value={newQ.question_text} onChange={(v) => setNewQ({ ...newQ, question_text: v })} />
            <label className="block">
              <span className="text-sm text-zinc-400">Field Type</span>
              <select
                value={newQ.field_type}
                onChange={(e) => setNewQ({ ...newQ, field_type: e.target.value })}
                className="mt-1 w-full rounded border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-100"
              >
                {Object.entries(FIELD_TYPE_LABELS).map(([k, v]) => (
                  <option key={k} value={k}>{v}</option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-2 text-sm text-zinc-300">
              <input
                type="checkbox"
                checked={newQ.is_required}
                onChange={(e) => setNewQ({ ...newQ, is_required: e.target.checked })}
                className="rounded"
              />
              Required
            </label>
          </div>
          <div className="mt-3 flex justify-end gap-2">
            <button onClick={() => setShowAdd(false)} className="text-sm text-zinc-400">Cancel</button>
            <button onClick={handleAdd} disabled={!newQ.question_text.trim()} className="rounded bg-blue-600 px-3 py-1 text-sm text-white hover:bg-blue-500 disabled:opacity-50">
              Add
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Shared UI Helpers ────────────────────────────────────────────────────────

function InfoRow({ label, value, multiline }: { label: string; value: string | null | undefined; multiline?: boolean }) {
  return (
    <div>
      <dt className="text-xs font-medium text-zinc-500">{label}</dt>
      <dd className={`mt-0.5 text-sm text-zinc-200 ${multiline ? 'whitespace-pre-wrap' : ''}`}>
        {value || <span className="text-zinc-600">—</span>}
      </dd>
    </div>
  );
}

function EditField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <label className="block">
      <span className="text-sm text-zinc-400">{label}</span>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1 w-full rounded border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-100"
      />
    </label>
  );
}

function EditTextArea({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <label className="block">
      <span className="text-sm text-zinc-400">{label}</span>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={3}
        className="mt-1 w-full rounded border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-100"
      />
    </label>
  );
}
