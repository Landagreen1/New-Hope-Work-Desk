'use client';

import { Save, X } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';

import type { ProfileLite } from '../nhwd-shared/client';
import { ui } from '../nhwd-shared/ui';
import type { CsIntakeDriver, CsIntakeSubmission, CsIntakeVehicle } from './api';
import { updateCustomerIntake } from './api';

// ─── Types ────────────────────────────────────────────────────────────────────

type CustomerIntake = CsIntakeSubmission;

export interface IntakeEditFormProps {
  intake: CustomerIntake;
  drivers: CsIntakeDriver[];
  vehicles: CsIntakeVehicle[];
  profile: ProfileLite;
  onSave: () => void;
  onCancel: () => void;
}

// Editable field subset for post-claim editing
const EDITABLE_FIELDS = [
  'insured_first_name',
  'insured_last_name',
  'insured_phone_primary',
  'insured_email',
  'addr_street',
  'addr_city',
  'addr_state',
  'addr_zip',
  'csr_notes',
  'desired_coverage',
  'liability_limit',
  'comprehensive_deductible',
  'collision_deductible',
] as const;

type EditableField = (typeof EDITABLE_FIELDS)[number];

const FIELD_LABELS: Record<EditableField, string> = {
  insured_first_name: 'First Name',
  insured_last_name: 'Last Name',
  insured_phone_primary: 'Phone',
  insured_email: 'Email',
  addr_street: 'Street Address',
  addr_city: 'City',
  addr_state: 'State',
  addr_zip: 'ZIP',
  csr_notes: 'CSR Notes',
  desired_coverage: 'Desired Coverage',
  liability_limit: 'Liability Limit',
  comprehensive_deductible: 'Comp. Deductible',
  collision_deductible: 'Coll. Deductible',
};

const US_STATES = [
  'AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY',
];

// ─── Validation ───────────────────────────────────────────────────────────────

interface FieldError {
  field: string;
  message: string;
}

function validateFields(
  values: Record<EditableField, string>,
  isManager: boolean,
  reason: string,
): FieldError[] {
  const errors: FieldError[] = [];

  if (!values.insured_first_name.trim()) {
    errors.push({ field: 'insured_first_name', message: 'First name is required.' });
  }
  if (!values.insured_last_name.trim()) {
    errors.push({ field: 'insured_last_name', message: 'Last name is required.' });
  }
  // Phone or email required
  if (!values.insured_phone_primary.trim() && !values.insured_email.trim()) {
    errors.push({ field: 'insured_phone_primary', message: 'Phone or email is required.' });
    errors.push({ field: 'insured_email', message: 'Phone or email is required.' });
  }
  if (values.insured_email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.insured_email.trim())) {
    errors.push({ field: 'insured_email', message: 'Invalid email format.' });
  }
  if (values.addr_state.trim() && !US_STATES.includes(values.addr_state.trim().toUpperCase())) {
    errors.push({ field: 'addr_state', message: 'Invalid state abbreviation.' });
  }
  if (values.addr_zip.trim() && !/^\d{5}(-\d{4})?$/.test(values.addr_zip.trim())) {
    errors.push({ field: 'addr_zip', message: 'Invalid ZIP code format.' });
  }

  // Manager must provide reason
  if (isManager && reason.trim().length < 5) {
    errors.push({ field: 'reason', message: 'Reason is required (minimum 5 characters).' });
  }

  return errors;
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function IntakeEditForm({
  intake,
  drivers: _drivers,
  vehicles: _vehicles,
  profile,
  onSave,
  onCancel,
}: IntakeEditFormProps) {
  const isManager = profile.role === 'manager' || profile.role === 'super_admin';

  // Initialize form values from intake
  const initialValues = useMemo(() => {
    const vals: Record<EditableField, string> = {} as Record<EditableField, string>;
    for (const field of EDITABLE_FIELDS) {
      const raw = intake[field as keyof CustomerIntake];
      vals[field] = raw != null ? String(raw) : '';
    }
    return vals;
  }, [intake]);

  const [values, setValues] = useState<Record<EditableField, string>>(initialValues);
  const [reason, setReason] = useState('');
  const [errors, setErrors] = useState<FieldError[]>([]);
  const [busy, setBusy] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  // Track which fields actually changed
  const changedFields = useMemo(() => {
    const changed: Partial<Record<EditableField, string | null>> = {};
    for (const field of EDITABLE_FIELDS) {
      const current = values[field].trim();
      const original = initialValues[field].trim();
      if (current !== original) {
        changed[field] = current || null;
      }
    }
    return changed;
  }, [values, initialValues]);

  const hasChanges = Object.keys(changedFields).length > 0;

  const getFieldError = useCallback(
    (field: string) => errors.find((e) => e.field === field)?.message ?? null,
    [errors],
  );

  const handleChange = useCallback((field: EditableField, value: string) => {
    setValues((prev) => ({ ...prev, [field]: value }));
    // Clear field error on change
    setErrors((prev) => prev.filter((e) => e.field !== field));
  }, []);

  const handleSave = useCallback(async () => {
    setServerError(null);
    const validationErrors = validateFields(values, isManager, reason);
    setErrors(validationErrors);
    if (validationErrors.length > 0) return;
    if (!hasChanges) return;

    setBusy(true);
    try {
      const changes: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(changedFields)) {
        changes[key] = val;
      }
      const result = await updateCustomerIntake(
        intake.id,
        changes,
        isManager ? reason.trim() : undefined,
      );
      if (!result.success) {
        setServerError(result.error ?? 'The edit could not be saved.');
        return;
      }
      onSave();
    } catch (err) {
      setServerError(err instanceof Error ? err.message : 'The edit could not be saved.');
    } finally {
      setBusy(false);
    }
  }, [values, isManager, reason, hasChanges, changedFields, intake.id, onSave]);

  // Determine if save should be disabled
  const saveDisabled = busy || !hasChanges || (isManager && reason.trim().length < 5);

  return (
    <div className="space-y-5">
      {serverError && <div className={ui.error}>{serverError}</div>}

      <section className={ui.card}>
        <div className={ui.cardHeader}>
          <div>
            <h3 className="text-lg font-black text-slate-950">Edit Intake</h3>
            <p className="mt-1 text-sm font-semibold text-slate-500">
              Update customer information. Changes are recorded in history.
            </p>
          </div>
          {hasChanges && (
            <span className={`${ui.badge} ${ui.badgeTone.info}`}>
              {Object.keys(changedFields).length} field{Object.keys(changedFields).length > 1 ? 's' : ''} changed
            </span>
          )}
        </div>
        <div className={ui.cardPad}>
          {/* Customer Information */}
          <p className={`${ui.sectionTitle} mb-4`}>Customer Information</p>
          <div className={ui.fieldRow}>
            <EditField
              label={FIELD_LABELS.insured_first_name}
              value={values.insured_first_name}
              error={getFieldError('insured_first_name')}
              changed={changedFields.insured_first_name !== undefined}
              disabled={busy}
              onChange={(v) => handleChange('insured_first_name', v)}
              required
            />
            <EditField
              label={FIELD_LABELS.insured_last_name}
              value={values.insured_last_name}
              error={getFieldError('insured_last_name')}
              changed={changedFields.insured_last_name !== undefined}
              disabled={busy}
              onChange={(v) => handleChange('insured_last_name', v)}
              required
            />
            <EditField
              label={FIELD_LABELS.insured_phone_primary}
              value={values.insured_phone_primary}
              error={getFieldError('insured_phone_primary')}
              changed={changedFields.insured_phone_primary !== undefined}
              disabled={busy}
              onChange={(v) => handleChange('insured_phone_primary', v)}
              type="tel"
            />
            <EditField
              label={FIELD_LABELS.insured_email}
              value={values.insured_email}
              error={getFieldError('insured_email')}
              changed={changedFields.insured_email !== undefined}
              disabled={busy}
              onChange={(v) => handleChange('insured_email', v)}
              type="email"
            />
          </div>

          {/* Address */}
          <p className={`${ui.sectionTitle} mb-4 mt-6`}>Address</p>
          <div className={ui.fieldRow}>
            <EditField
              label={FIELD_LABELS.addr_street}
              value={values.addr_street}
              error={getFieldError('addr_street')}
              changed={changedFields.addr_street !== undefined}
              disabled={busy}
              onChange={(v) => handleChange('addr_street', v)}
            />
            <EditField
              label={FIELD_LABELS.addr_city}
              value={values.addr_city}
              error={getFieldError('addr_city')}
              changed={changedFields.addr_city !== undefined}
              disabled={busy}
              onChange={(v) => handleChange('addr_city', v)}
            />
            <div className="grid grid-cols-2 gap-3">
              <label className="block">
                <span className={ui.label}>{FIELD_LABELS.addr_state}</span>
                <select
                  className={`${ui.select}${changedFields.addr_state !== undefined ? ' ring-2 ring-blue-300' : ''}${getFieldError('addr_state') ? ' border-rose-400 ring-2 ring-rose-200' : ''}`}
                  disabled={busy}
                  value={values.addr_state}
                  onChange={(e) => handleChange('addr_state', e.target.value)}
                >
                  <option value="">--</option>
                  {US_STATES.map((st) => (
                    <option key={st} value={st}>
                      {st}
                    </option>
                  ))}
                </select>
                {getFieldError('addr_state') && (
                  <span className="mt-1 block text-xs font-bold text-rose-600">{getFieldError('addr_state')}</span>
                )}
              </label>
              <EditField
                label={FIELD_LABELS.addr_zip}
                value={values.addr_zip}
                error={getFieldError('addr_zip')}
                changed={changedFields.addr_zip !== undefined}
                disabled={busy}
                onChange={(v) => handleChange('addr_zip', v)}
              />
            </div>
          </div>

          {/* Coverage */}
          <p className={`${ui.sectionTitle} mb-4 mt-6`}>Coverage</p>
          <div className={ui.fieldRow}>
            <label className="block">
              <span className={ui.label}>{FIELD_LABELS.desired_coverage}</span>
              <select
                className={`${ui.select}${changedFields.desired_coverage !== undefined ? ' ring-2 ring-blue-300' : ''}`}
                disabled={busy}
                value={values.desired_coverage}
                onChange={(e) => handleChange('desired_coverage', e.target.value)}
              >
                <option value="">Select coverage</option>
                <option value="liability_only">Liability Only</option>
                <option value="full_coverage">Full Coverage</option>
                <option value="unsure">Customer Unsure</option>
              </select>
            </label>
            <EditField
              label={FIELD_LABELS.liability_limit}
              value={values.liability_limit}
              error={getFieldError('liability_limit')}
              changed={changedFields.liability_limit !== undefined}
              disabled={busy}
              onChange={(v) => handleChange('liability_limit', v)}
              placeholder="e.g. 100/300/100"
            />
            <EditField
              label={FIELD_LABELS.comprehensive_deductible}
              value={values.comprehensive_deductible}
              error={getFieldError('comprehensive_deductible')}
              changed={changedFields.comprehensive_deductible !== undefined}
              disabled={busy}
              onChange={(v) => handleChange('comprehensive_deductible', v)}
              placeholder="e.g. $500"
            />
            <EditField
              label={FIELD_LABELS.collision_deductible}
              value={values.collision_deductible}
              error={getFieldError('collision_deductible')}
              changed={changedFields.collision_deductible !== undefined}
              disabled={busy}
              onChange={(v) => handleChange('collision_deductible', v)}
              placeholder="e.g. $1,000"
            />
          </div>

          {/* Notes */}
          <p className={`${ui.sectionTitle} mb-4 mt-6`}>Notes</p>
          <label className="block">
            <span className={ui.label}>{FIELD_LABELS.csr_notes}</span>
            <textarea
              rows={3}
              className={`${ui.textarea}${changedFields.csr_notes !== undefined ? ' ring-2 ring-blue-300' : ''}`}
              disabled={busy}
              value={values.csr_notes}
              onChange={(e) => handleChange('csr_notes', e.target.value)}
              placeholder="Additional notes for the Agent."
            />
          </label>

          {/* Manager reason field */}
          {isManager && (
            <>
              <p className={`${ui.sectionTitle} mb-4 mt-6`}>Manager Edit Reason</p>
              <label className="block">
                <span className={ui.label}>Reason *</span>
                <textarea
                  rows={2}
                  className={`${ui.textarea}${getFieldError('reason') ? ' border-rose-400 ring-2 ring-rose-200' : ''}`}
                  disabled={busy}
                  value={reason}
                  onChange={(e) => {
                    setReason(e.target.value);
                    setErrors((prev) => prev.filter((er) => er.field !== 'reason'));
                  }}
                  placeholder="Explain why this edit is being made (min 5 characters)."
                />
                {getFieldError('reason') && (
                  <span className="mt-1 block text-xs font-bold text-rose-600">{getFieldError('reason')}</span>
                )}
                <span className="mt-1 block text-xs font-semibold text-slate-400">
                  {reason.trim().length}/5 characters minimum
                </span>
              </label>
            </>
          )}
        </div>
      </section>

      {/* Action bar */}
      <div className="sticky bottom-4 z-20 flex items-center justify-between rounded-2xl border border-slate-200 bg-white/95 p-4 shadow-xl backdrop-blur">
        <p className="text-sm font-semibold text-slate-500">
          {hasChanges
            ? `${Object.keys(changedFields).length} field${Object.keys(changedFields).length > 1 ? 's' : ''} will be saved to history.`
            : 'No changes made.'}
        </p>
        <div className="flex gap-2">
          <button type="button" className={ui.btnGhost} disabled={busy} onClick={onCancel}>
            <X className="h-4 w-4" /> Cancel
          </button>
          <button
            type="button"
            className={ui.btnPrimary}
            disabled={saveDisabled}
            onClick={() => void handleSave()}
          >
            <Save className="h-4 w-4" /> Save Changes
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Inline Field Component ───────────────────────────────────────────────────

function EditField({
  label,
  value,
  error,
  changed,
  disabled,
  onChange,
  type = 'text',
  required,
  placeholder,
}: {
  label: string;
  value: string;
  error: string | null;
  changed: boolean;
  disabled: boolean;
  onChange: (value: string) => void;
  type?: 'text' | 'tel' | 'email';
  required?: boolean;
  placeholder?: string;
}) {
  return (
    <label className="block">
      <span className={ui.label}>
        {label}
        {required ? ' *' : ''}
      </span>
      <input
        type={type}
        className={`${ui.input}${changed ? ' ring-2 ring-blue-300' : ''}${error ? ' border-rose-400 ring-2 ring-rose-200' : ''}`}
        disabled={disabled}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
      />
      {error && <span className="mt-1 block text-xs font-bold text-rose-600">{error}</span>}
    </label>
  );
}
