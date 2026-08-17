'use client';

/**
 * Carrier Market Extensions
 *
 * Additional UI sections that extend the existing CarrierMarketRow in the
 * OpportunityDrawer. These render inside the expanded carrier market area
 * and add:
 *   - Market Directory link & info
 *   - Readiness indicator
 *   - Supplemental questions
 *   - Underwriting results
 *   - Generate Application button
 *   - Generated application history
 *
 * v1.17.0
 */

import { useCallback, useEffect, useState } from 'react';
import {
  addUnderwritingResult,
  calculateReadiness,
  getAnswersForCarrierMarket,
  getGeneratedApplications,
  getUnderwritingResults,
  listQuestions,
  markApplicationSubmitted,
  removeUnderwritingResult,
  saveAnswer,
} from './api';
import type {
  GeneratedApplication,
  MarketQuestion,
  MarketQuestionAnswer,
  ReadinessInfo,
  UnderwritingResult,
} from './types';

// ═══════════════════════════════════════════════════════════════════════════════
// Readiness Badge
// ═══════════════════════════════════════════════════════════════════════════════

const READINESS_LABELS: Record<string, string> = {
  ready: 'Ready',
  missing_information: 'Missing Information',
  missing_documents: 'Missing Documents',
  review_required: 'Review Required',
};

const READINESS_COLORS: Record<string, string> = {
  ready: 'bg-green-100 text-green-700',
  missing_information: 'bg-amber-100 text-amber-700',
  missing_documents: 'bg-red-100 text-red-700',
  review_required: 'bg-blue-100 text-blue-700',
};

export function ReadinessBadge({ readiness }: { readiness: ReadinessInfo | null }) {
  if (!readiness) return null;

  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${READINESS_COLORS[readiness.state] ?? 'bg-gray-100 text-gray-600'}`}>
      {READINESS_LABELS[readiness.state] ?? readiness.state}
      {readiness.missing_items.length > 0 && (
        <span className="ml-1">({readiness.missing_items.length})</span>
      )}
    </span>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// Readiness Panel
// ═══════════════════════════════════════════════════════════════════════════════

export function ReadinessPanel({
  carrierMarketId,
  marketDirectoryId,
  lineOfBusiness,
}: {
  carrierMarketId: string;
  marketDirectoryId: string | null;
  lineOfBusiness: string;
}) {
  const [readiness, setReadiness] = useState<ReadinessInfo | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!marketDirectoryId) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true);
    calculateReadiness(carrierMarketId, marketDirectoryId, lineOfBusiness)
      .then(setReadiness)
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [carrierMarketId, marketDirectoryId, lineOfBusiness]);

  if (!marketDirectoryId) {
    return (
      <p className="text-xs text-slate-400 italic">
        No Market Directory entry linked. Readiness unavailable.
      </p>
    );
  }

  if (loading) return <p className="text-xs text-slate-400">Checking readiness...</p>;
  if (!readiness) return null;

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold text-slate-600">Submission Readiness</span>
        <ReadinessBadge readiness={readiness} />
      </div>
      {readiness.missing_items.length > 0 && (
        <div className="mt-2 space-y-1">
          {readiness.missing_items.map((item) => (
            <div key={item.requirement_id} className="flex items-center gap-2 text-xs">
              <span className={`h-1.5 w-1.5 rounded-full ${item.is_required ? 'bg-red-400' : 'bg-amber-400'}`} />
              <span className="text-slate-600">{item.label}</span>
              <span className="text-slate-400">({item.requirement_type})</span>
            </div>
          ))}
        </div>
      )}
      {readiness.state === 'ready' && (
        <p className="mt-1 text-xs text-green-600">All requirements met. Ready to submit.</p>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// Supplemental Questions
// ═══════════════════════════════════════════════════════════════════════════════

export function SupplementalQuestions({
  carrierMarketId,
  marketDirectoryId,
  lineOfBusiness,
  profileId,
}: {
  carrierMarketId: string;
  marketDirectoryId: string | null;
  lineOfBusiness: string;
  profileId: string;
}) {
  const [questions, setQuestions] = useState<MarketQuestion[]>([]);
  const [answers, setAnswers] = useState<MarketQuestionAnswer[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!marketDirectoryId) return;
    setLoading(true);
    try {
      const [qs, as_] = await Promise.all([
        listQuestions(marketDirectoryId, lineOfBusiness),
        getAnswersForCarrierMarket(carrierMarketId),
      ]);
      setQuestions(qs);
      setAnswers(as_);
    } catch (err) {
      console.error('Failed to load questions:', err);
    } finally {
      setLoading(false);
    }
  }, [carrierMarketId, marketDirectoryId, lineOfBusiness]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  const handleSave = async (questionId: string, value: string | null) => {
    setSaving(questionId);
    try {
      await saveAnswer(carrierMarketId, questionId, value, profileId);
      // Update local state
      setAnswers((prev) => {
        const existing = prev.find((a) => a.question_id === questionId);
        if (existing) {
          return prev.map((a) => a.question_id === questionId ? { ...a, answer_value: value } : a);
        }
        return [...prev, { id: '', carrier_market_id: carrierMarketId, question_id: questionId, answer_value: value, answered_by: profileId, answered_at: new Date().toISOString() }];
      });
    } catch (err) {
      console.error('Failed to save answer:', err);
    } finally {
      setSaving(null);
    }
  };

  if (!marketDirectoryId) return null;
  if (loading) return <p className="text-xs text-slate-400">Loading questions...</p>;
  if (questions.length === 0) return null;

  const answerMap = new Map(answers.map((a) => [a.question_id, a.answer_value]));

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-3">
      <h4 className="mb-2 text-xs font-semibold text-slate-600">Market-Specific Questions</h4>
      <div className="space-y-2">
        {questions.map((q) => (
          <QuestionField
            key={q.id}
            question={q}
            value={answerMap.get(q.id) ?? null}
            onSave={(v) => handleSave(q.id, v)}
            saving={saving === q.id}
          />
        ))}
      </div>
    </div>
  );
}

function QuestionField({
  question,
  value,
  onSave,
  saving,
}: {
  question: MarketQuestion;
  value: string | null;
  onSave: (v: string | null) => void;
  saving: boolean;
}) {
  const [localValue, setLocalValue] = useState(value ?? '');

  // Sync prop changes to local state
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { setLocalValue(value ?? ''); }, [value]);

  const handleBlur = () => {
    const newValue = localValue.trim() || null;
    if (newValue !== value) {
      onSave(newValue);
    }
  };

  return (
    <label className="block">
      <span className="text-xs text-slate-500">
        {question.question_text}
        {question.is_required && <span className="ml-0.5 text-red-400">*</span>}
        {saving && <span className="ml-1 text-blue-400">(saving...)</span>}
      </span>
      {question.field_type === 'yes_no' ? (
        <select
          className="mt-0.5 w-full rounded border border-slate-200 px-2 py-1 text-xs"
          value={localValue}
          onChange={(e) => { setLocalValue(e.target.value); onSave(e.target.value || null); }}
        >
          <option value="">—</option>
          <option value="Yes">Yes</option>
          <option value="No">No</option>
        </select>
      ) : question.field_type === 'select' ? (
        <select
          className="mt-0.5 w-full rounded border border-slate-200 px-2 py-1 text-xs"
          value={localValue}
          onChange={(e) => { setLocalValue(e.target.value); onSave(e.target.value || null); }}
        >
          <option value="">—</option>
          {(question.select_options ?? []).map((opt) => (
            <option key={opt} value={opt}>{opt}</option>
          ))}
        </select>
      ) : question.field_type === 'long_text' ? (
        <textarea
          className="mt-0.5 w-full rounded border border-slate-200 px-2 py-1 text-xs"
          rows={2}
          value={localValue}
          onChange={(e) => setLocalValue(e.target.value)}
          onBlur={handleBlur}
        />
      ) : (
        <input
          type={question.field_type === 'date' ? 'date' : question.field_type === 'number' || question.field_type === 'currency' || question.field_type === 'percentage' ? 'number' : 'text'}
          className="mt-0.5 w-full rounded border border-slate-200 px-2 py-1 text-xs"
          value={localValue}
          onChange={(e) => setLocalValue(e.target.value)}
          onBlur={handleBlur}
          step={question.field_type === 'currency' ? '0.01' : question.field_type === 'percentage' ? '0.1' : undefined}
        />
      )}
    </label>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// Underwriting Results
// ═══════════════════════════════════════════════════════════════════════════════

export function UnderwritingResultsPanel({
  carrierMarketId,
  profileId,
}: {
  carrierMarketId: string;
  profileId: string;
}) {
  const [results, setResults] = useState<UnderwritingResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [newResult, setNewResult] = useState({ underwriting_carrier: '', coverage_type: '', premium: '', notes: '' });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await getUnderwritingResults(carrierMarketId);
      setResults(data);
    } catch (err) {
      console.error('Failed to load underwriting results:', err);
    } finally {
      setLoading(false);
    }
  }, [carrierMarketId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  const handleAdd = async () => {
    if (!newResult.underwriting_carrier.trim() || !newResult.coverage_type.trim()) return;
    try {
      await addUnderwritingResult(
        carrierMarketId,
        {
          underwriting_carrier: newResult.underwriting_carrier.trim(),
          coverage_type: newResult.coverage_type.trim(),
          premium: newResult.premium ? parseFloat(newResult.premium) : null,
          notes: newResult.notes.trim() || null,
        },
        profileId,
      );
      setNewResult({ underwriting_carrier: '', coverage_type: '', premium: '', notes: '' });
      setShowAdd(false);
      load();
    } catch (err) {
      console.error('Failed to add result:', err);
    }
  };

  const handleRemove = async (resultId: string) => {
    try {
      await removeUnderwritingResult(resultId);
      load();
    } catch (err) {
      console.error('Failed to remove result:', err);
    }
  };

  if (loading) return <p className="text-xs text-slate-400">Loading results...</p>;

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-3">
      <div className="mb-2 flex items-center justify-between">
        <h4 className="text-xs font-semibold text-slate-600">Underwriting Carriers / Results</h4>
        <button
          onClick={() => setShowAdd(true)}
          className="rounded bg-slate-100 px-2 py-0.5 text-xs text-slate-600 hover:bg-slate-200"
        >
          + Add
        </button>
      </div>

      {results.length === 0 && !showAdd && (
        <p className="text-xs text-slate-400 italic">No underwriting results recorded yet.</p>
      )}

      {results.length > 0 && (
        <div className="space-y-1.5">
          {results.map((r) => (
            <div key={r.id} className="flex items-center justify-between rounded bg-slate-50 px-2 py-1.5">
              <div>
                <span className="text-xs font-medium text-slate-700">{r.underwriting_carrier}</span>
                <span className="ml-1.5 text-xs text-slate-500">→ {r.coverage_type}</span>
                {r.premium && (
                  <span className="ml-1.5 text-xs font-medium text-slate-700">
                    ${r.premium.toLocaleString()}
                  </span>
                )}
              </div>
              <button
                onClick={() => handleRemove(r.id)}
                className="text-xs text-red-400 hover:text-red-600"
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}

      {showAdd && (
        <div className="mt-2 rounded border border-slate-200 bg-slate-50 p-2">
          <div className="grid grid-cols-2 gap-2">
            <label className="block">
              <span className="text-xs text-slate-500">Underwriting Carrier</span>
              <input
                type="text"
                className="mt-0.5 w-full rounded border border-slate-200 px-2 py-1 text-xs"
                value={newResult.underwriting_carrier}
                onChange={(e) => setNewResult({ ...newResult, underwriting_carrier: e.target.value })}
                placeholder="e.g. NICO, Lloyd's"
              />
            </label>
            <label className="block">
              <span className="text-xs text-slate-500">Coverage Type</span>
              <input
                type="text"
                className="mt-0.5 w-full rounded border border-slate-200 px-2 py-1 text-xs"
                value={newResult.coverage_type}
                onChange={(e) => setNewResult({ ...newResult, coverage_type: e.target.value })}
                placeholder="e.g. Auto Liability, Cargo"
              />
            </label>
            <label className="block">
              <span className="text-xs text-slate-500">Premium</span>
              <input
                type="number"
                step="0.01"
                className="mt-0.5 w-full rounded border border-slate-200 px-2 py-1 text-xs"
                value={newResult.premium}
                onChange={(e) => setNewResult({ ...newResult, premium: e.target.value })}
              />
            </label>
            <label className="block">
              <span className="text-xs text-slate-500">Notes</span>
              <input
                type="text"
                className="mt-0.5 w-full rounded border border-slate-200 px-2 py-1 text-xs"
                value={newResult.notes}
                onChange={(e) => setNewResult({ ...newResult, notes: e.target.value })}
              />
            </label>
          </div>
          <div className="mt-2 flex justify-end gap-1">
            <button onClick={() => setShowAdd(false)} className="px-2 py-0.5 text-xs text-slate-400">Cancel</button>
            <button
              onClick={handleAdd}
              disabled={!newResult.underwriting_carrier.trim() || !newResult.coverage_type.trim()}
              className="rounded bg-blue-500 px-2 py-0.5 text-xs text-white hover:bg-blue-600 disabled:opacity-50"
            >
              Add
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// Generate Application
// ═══════════════════════════════════════════════════════════════════════════════

export function GenerateApplicationPanel({
  carrierMarketId,
  opportunityId,
  marketDirectoryId,
  lineOfBusiness,
  profileId,
}: {
  carrierMarketId: string;
  opportunityId: string;
  marketDirectoryId: string | null;
  lineOfBusiness: string;
  profileId: string;
}) {
  const [applications, setApplications] = useState<GeneratedApplication[]>([]);
  const [loading, setLoading] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await getGeneratedApplications(carrierMarketId);
      setApplications(data);
    } catch (err) {
      console.error('Failed to load applications:', err);
    } finally {
      setLoading(false);
    }
  }, [carrierMarketId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  const handleGenerate = async (templateId: string) => {
    setGenerating(true);
    setError(null);
    try {
      const response = await fetch('/api/specialty/generate-application', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          carrier_market_id: carrierMarketId,
          template_id: templateId,
          opportunity_id: opportunityId,
        }),
      });
      const result = await response.json();
      if (!response.ok) {
        setError(result.error || 'Generation failed');
        return;
      }
      if (result.warnings?.length > 0) {
        setError(`Generated with warnings: ${result.warnings.join('; ')}`);
      }
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Generation failed');
    } finally {
      setGenerating(false);
    }
  };

  const handleMarkSubmitted = async (applicationId: string) => {
    try {
      await markApplicationSubmitted(applicationId, profileId);
      load();
    } catch (err) {
      console.error('Failed to mark submitted:', err);
    }
  };

  if (!marketDirectoryId) return null;

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-3">
      <div className="mb-2 flex items-center justify-between">
        <h4 className="text-xs font-semibold text-slate-600">Applications</h4>
        <GenerateButton
          marketDirectoryId={marketDirectoryId}
          lineOfBusiness={lineOfBusiness}
          onGenerate={handleGenerate}
          generating={generating}
        />
      </div>

      {error && <p className="mb-2 text-xs text-amber-600">{error}</p>}

      {loading ? (
        <p className="text-xs text-slate-400">Loading...</p>
      ) : applications.length === 0 ? (
        <p className="text-xs text-slate-400 italic">No applications generated yet.</p>
      ) : (
        <div className="space-y-1.5">
          {applications.map((app) => (
            <div key={app.id} className="flex items-center justify-between rounded bg-slate-50 px-2 py-1.5">
              <div>
                <span className="text-xs font-medium text-slate-700">{app.file_name}</span>
                <span className="ml-1.5 text-xs text-slate-400">
                  v{app.generation_version} · {new Date(app.generated_at).toLocaleDateString()}
                </span>
                <span className={`ml-1.5 text-xs ${app.status === 'submitted' ? 'text-green-600' : app.status === 'review_required' ? 'text-amber-600' : 'text-slate-500'}`}>
                  {app.status === 'review_required' ? 'Review Required' : app.status === 'submitted' ? 'Submitted' : app.status}
                </span>
              </div>
              {app.status === 'review_required' && (
                <button
                  onClick={() => handleMarkSubmitted(app.id)}
                  className="rounded bg-green-50 px-2 py-0.5 text-xs text-green-700 hover:bg-green-100"
                >
                  Mark Submitted
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function GenerateButton({
  marketDirectoryId,
  lineOfBusiness,
  onGenerate,
  generating,
}: {
  marketDirectoryId: string;
  lineOfBusiness: string;
  onGenerate: (templateId: string) => void;
  generating: boolean;
}) {
  const [templates, setTemplates] = useState<{ id: string; template_name: string }[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    import('./api').then(({ listTemplates }) =>
      listTemplates(marketDirectoryId, lineOfBusiness).then((ts) => {
        setTemplates(ts.map((t) => ({ id: t.id, template_name: t.template_name })));
        setLoaded(true);
      }),
    ).catch(console.error);
  }, [marketDirectoryId, lineOfBusiness]);

  if (!loaded || templates.length === 0) return null;

  if (templates.length === 1) {
    return (
      <button
        onClick={() => onGenerate(templates[0].id)}
        disabled={generating}
        className="rounded bg-blue-500 px-2 py-0.5 text-xs text-white hover:bg-blue-600 disabled:opacity-50"
      >
        {generating ? 'Generating...' : `Generate ${templates[0].template_name}`}
      </button>
    );
  }

  return (
    <select
      onChange={(e) => { if (e.target.value) onGenerate(e.target.value); }}
      disabled={generating}
      className="rounded border border-slate-200 px-2 py-0.5 text-xs"
      defaultValue=""
    >
      <option value="" disabled>{generating ? 'Generating...' : 'Generate Application...'}</option>
      {templates.map((t) => (
        <option key={t.id} value={t.id}>{t.template_name}</option>
      ))}
    </select>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// Stale Warning
// ═══════════════════════════════════════════════════════════════════════════════

export function StaleApplicationWarning({
  currentHash,
  applications,
}: {
  currentHash: string | null;
  applications: GeneratedApplication[];
}) {
  if (!currentHash || applications.length === 0) return null;

  const latest = applications[0]; // sorted desc by generated_at
  if (latest.source_data_hash === currentHash) return null;
  if (latest.status === 'superseded') return null;

  return (
    <div className="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700">
      <strong>Information changed</strong> since this application was generated.
      Regeneration recommended.
    </div>
  );
}
