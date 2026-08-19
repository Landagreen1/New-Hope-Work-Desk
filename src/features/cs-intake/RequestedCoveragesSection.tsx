'use client';

import { ShieldCheck } from 'lucide-react';
import { ui } from '../nhwd-shared/ui';
import {
  AgentGuidance,
  CoverageBlock,
  Field,
  MoneyInput,
  WarningBanner,
  YesNo,
  YesNoNotSure,
} from './trucking-fields';

/** Desired Auto Liability limits. `other` reveals a free-text box. */
export const AUTO_LIABILITY_LIMITS = [
  { key: '300000', label: '$300,000' },
  { key: '500000', label: '$500,000' },
  { key: '750000', label: '$750,000' },
  { key: '1000000', label: '$1,000,000' },
  { key: 'other', label: 'Other' },
] as const;

/**
 * Desired Motor Truck Cargo limits.
 *
 * `no_cargo` is a real answer, not an absence of one: it sets
 * `cargo_coverage_desired = false` so nothing downstream has to guess.
 */
export const CARGO_LIMIT_CHOICES = [
  { key: 'no_cargo', label: 'No Cargo', amount: null },
  { key: '25000', label: '$25,000', amount: 25000 },
  { key: '50000', label: '$50,000', amount: 50000 },
  { key: '100000', label: '$100,000', amount: 100000 },
  { key: '150000', label: '$150,000', amount: 150000 },
  { key: '250000', label: '$250,000', amount: 250000 },
  { key: 'other', label: 'Other', amount: null },
] as const;

/** Human label for a stored Auto Liability limit, for PDFs and read-only views. */
export function autoLiabilityLimitLabel(
  limit: string | null | undefined,
  other: string | null | undefined,
): string {
  if (!limit) return '';
  if (limit === 'other') return other?.trim() || 'Other';
  return AUTO_LIABILITY_LIMITS.find((option) => option.key === limit)?.label ?? limit;
}

export interface RequestedCoveragesData {
  // Auto Liability
  auto_liability_limit: string;
  auto_liability_limit_other: string;
  um_uim_limit: string;
  hired_auto: string;
  non_owned_auto: string;
  // Physical Damage
  physical_damage_needed: boolean | null;
  physical_damage_deductible_requested: string;
  pd_comprehensive: boolean | null;
  pd_collision: boolean | null;
  pd_specified_causes: boolean | null;
  // Motor Truck Cargo
  cargo_coverage_desired: boolean | null;
  requested_cargo_limit: number | null;
  cargo_deductible: number | null;
  reefer_breakdown_requested: string;
  // Trailer Interchange
  pulls_non_owned_trailers: boolean | null;
  trailer_interchange_agreement: boolean | null;
  trailer_interchange_limit: string;
  trailer_interchange_deductible: string;
  // Additional
  general_liability_requested: boolean | null;
  general_liability_limit: string;
  medical_payments_requested: boolean | null;
  medical_payments_limit: string;
  additional_coverages_other: string;
}

interface RequestedCoveragesSectionProps {
  data: RequestedCoveragesData;
  onChange: (patch: Partial<RequestedCoveragesData>) => void;
  /**
   * Whether to ask about Refrigeration Breakdown. Driven by the refrigerated
   * answer / commodity selection in the Cargo section, so it is only asked when
   * it actually applies.
   */
  showRefrigerationBreakdown?: boolean;
  /** Highest single-load value known so far, used to flag an under-set cargo limit. */
  maxLoadValue?: number | null;
  disabled?: boolean;
}

export default function RequestedCoveragesSection({
  data,
  onChange,
  showRefrigerationBreakdown = false,
  maxLoadValue = null,
  disabled,
}: RequestedCoveragesSectionProps) {
  const wantsPhysicalDamage = data.physical_damage_needed === true;
  const pullsTrailers = data.pulls_non_owned_trailers === true;

  /** Which cargo choice the stored values represent. */
  const cargoChoice = (() => {
    if (data.cargo_coverage_desired === false) return 'no_cargo';
    if (data.cargo_coverage_desired !== true) return '';
    const match = CARGO_LIMIT_CHOICES.find(
      (option) => option.amount !== null && option.amount === data.requested_cargo_limit,
    );
    return match ? match.key : 'other';
  })();

  const wantsCargo = data.cargo_coverage_desired === true;
  const cargoIsOther = wantsCargo && cargoChoice === 'other';
  const cargoUnderMaxLoad =
    wantsCargo
    && maxLoadValue != null
    && data.requested_cargo_limit != null
    && maxLoadValue > data.requested_cargo_limit;

  /** One handler so the limit and the desired flag can never disagree. */
  function selectCargoChoice(key: string) {
    if (key === '') {
      onChange({ cargo_coverage_desired: null, requested_cargo_limit: null, cargo_deductible: null });
      return;
    }
    if (key === 'no_cargo') {
      // Explicitly declined. Clear the dependent answers so nothing stale survives.
      onChange({
        cargo_coverage_desired: false,
        requested_cargo_limit: null,
        cargo_deductible: null,
        reefer_breakdown_requested: '',
      });
      return;
    }
    const choice = CARGO_LIMIT_CHOICES.find((option) => option.key === key);
    onChange({
      cargo_coverage_desired: true,
      requested_cargo_limit: choice?.amount ?? null,
    });
  }

  /** Turning Physical Damage off clears its dependent answers. */
  function setPhysicalDamage(value: boolean | null) {
    if (value === true) {
      onChange({ physical_damage_needed: true });
      return;
    }
    onChange({
      physical_damage_needed: value,
      physical_damage_deductible_requested: '',
      pd_comprehensive: null,
      pd_collision: null,
      pd_specified_causes: null,
    });
  }

  /** Saying they do not pull others' trailers clears the interchange answers. */
  function setPullsTrailers(value: boolean | null) {
    if (value === true) {
      onChange({ pulls_non_owned_trailers: true });
      return;
    }
    onChange({
      pulls_non_owned_trailers: value,
      trailer_interchange_agreement: null,
      trailer_interchange_limit: '',
      trailer_interchange_deductible: '',
    });
  }

  return (
    <section className={ui.card}>
      <div className={ui.cardHeader}>
        <div className="flex items-start gap-3">
          <div className="grid h-10 w-10 shrink-0 place-items-center rounded-2xl bg-[#eef3fb] text-[#223f7a]">
            <ShieldCheck className="h-5 w-5" />
          </div>
          <div>
            <h3 className="text-lg font-black text-slate-950">Requested Coverages</h3>
            <p className="mt-1 text-sm font-semibold text-slate-500">
              What the customer is asking to be quoted. Only the Auto Liability limit is required.
            </p>
          </div>
        </div>
      </div>

      <div className={ui.cardPad}>
        <div className="space-y-4">
          {/* ─── Auto Liability ──────────────────────────────────────────────── */}
          <CoverageBlock title="Auto Liability" accent>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <Field label="Desired Auto Liability Limit" required>
                <select
                  className={ui.select}
                  value={data.auto_liability_limit}
                  onChange={(e) =>
                    onChange({
                      auto_liability_limit: e.target.value,
                      // Only the Other choice keeps a free-text value.
                      ...(e.target.value === 'other' ? {} : { auto_liability_limit_other: '' }),
                    })
                  }
                  disabled={disabled}
                >
                  <option value="">— Select —</option>
                  {AUTO_LIABILITY_LIMITS.map((option) => (
                    <option key={option.key} value={option.key}>{option.label}</option>
                  ))}
                </select>
              </Field>

              {data.auto_liability_limit === 'other' && (
                <Field label="Other Limit" required>
                  <input
                    type="text"
                    className={ui.input}
                    value={data.auto_liability_limit_other}
                    onChange={(e) => onChange({ auto_liability_limit_other: e.target.value })}
                    placeholder="e.g. $2,000,000 CSL"
                    disabled={disabled}
                  />
                </Field>
              )}

              <Field label="UM / UIM Limit">
                <input
                  type="text"
                  className={ui.input}
                  value={data.um_uim_limit}
                  onChange={(e) => onChange({ um_uim_limit: e.target.value })}
                  placeholder="e.g. $100,000 or Rejected"
                  disabled={disabled}
                />
              </Field>

              <Field label="Hired Auto">
                <YesNoNotSure
                  value={data.hired_auto}
                  onChange={(val) => onChange({ hired_auto: val })}
                  disabled={disabled}
                />
              </Field>

              <Field label="Non-Owned Auto">
                <YesNoNotSure
                  value={data.non_owned_auto}
                  onChange={(val) => onChange({ non_owned_auto: val })}
                  disabled={disabled}
                />
              </Field>
            </div>
          </CoverageBlock>

          {/* ─── Physical Damage ─────────────────────────────────────────────── */}
          <CoverageBlock title="Physical Damage">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <Field
                label="Physical Damage Needed?"
                hint="Each truck's value is entered under Vehicles."
              >
                <YesNo
                  value={data.physical_damage_needed}
                  onChange={setPhysicalDamage}
                  disabled={disabled}
                />
              </Field>

              {wantsPhysicalDamage && (
                <Field label="Deductible">
                  <input
                    type="text"
                    className={ui.input}
                    value={data.physical_damage_deductible_requested}
                    onChange={(e) => onChange({ physical_damage_deductible_requested: e.target.value })}
                    placeholder="e.g. $2,500"
                    disabled={disabled}
                  />
                </Field>
              )}
            </div>

            {wantsPhysicalDamage && (
              <div className="mt-4">
                <span className={ui.label}>Cause of Loss</span>
                <div className="mt-2 flex flex-wrap gap-5">
                  <label className={ui.checkboxRow}>
                    <input
                      type="checkbox"
                      checked={data.pd_comprehensive === true}
                      onChange={(e) => onChange({ pd_comprehensive: e.target.checked })}
                      disabled={disabled}
                    />
                    Comprehensive
                  </label>
                  <label className={ui.checkboxRow}>
                    <input
                      type="checkbox"
                      checked={data.pd_collision === true}
                      onChange={(e) => onChange({ pd_collision: e.target.checked })}
                      disabled={disabled}
                    />
                    Collision
                  </label>
                  <label className={ui.checkboxRow}>
                    <input
                      type="checkbox"
                      checked={data.pd_specified_causes === true}
                      onChange={(e) => onChange({ pd_specified_causes: e.target.checked })}
                      disabled={disabled}
                    />
                    Specified Causes of Loss
                  </label>
                </div>
              </div>
            )}
          </CoverageBlock>

          {/* ─── Motor Truck Cargo ───────────────────────────────────────────── */}
          <CoverageBlock title="Motor Truck Cargo">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <Field label="Desired Cargo Limit" required>
                <select
                  className={ui.select}
                  value={cargoChoice}
                  onChange={(e) => selectCargoChoice(e.target.value)}
                  disabled={disabled}
                >
                  <option value="">— Select —</option>
                  {CARGO_LIMIT_CHOICES.map((option) => (
                    <option key={option.key} value={option.key}>{option.label}</option>
                  ))}
                </select>
              </Field>

              {cargoIsOther && (
                <Field label="Other Cargo Limit" required>
                  <MoneyInput
                    value={data.requested_cargo_limit}
                    onChange={(val) => onChange({ requested_cargo_limit: val })}
                    placeholder="e.g. 300000"
                    disabled={disabled}
                  />
                </Field>
              )}

              {wantsCargo && (
                <Field label="Cargo Deductible">
                  <MoneyInput
                    value={data.cargo_deductible}
                    onChange={(val) => onChange({ cargo_deductible: val })}
                    placeholder="e.g. 2500"
                    disabled={disabled}
                  />
                </Field>
              )}

              {wantsCargo && showRefrigerationBreakdown && (
                <Field
                  label="Refrigeration Breakdown"
                  hint="Asked because refrigerated cargo was indicated."
                >
                  <YesNoNotSure
                    value={data.reefer_breakdown_requested}
                    onChange={(val) => onChange({ reefer_breakdown_requested: val })}
                    disabled={disabled}
                  />
                </Field>
              )}
            </div>

            {cargoUnderMaxLoad && (
              <div className="mt-4">
                <WarningBanner>
                  The highest load value recorded ({`$${maxLoadValue?.toLocaleString()}`}) is above the
                  requested Cargo limit. Confirm the limit before marketing this quote.
                </WarningBanner>
              </div>
            )}
          </CoverageBlock>

          {/* ─── Trailer Interchange ─────────────────────────────────────────── */}
          <CoverageBlock title="Trailer Interchange">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <Field label="Pulls trailers they do not own?">
                <YesNo
                  value={data.pulls_non_owned_trailers}
                  onChange={setPullsTrailers}
                  disabled={disabled}
                />
              </Field>

              {pullsTrailers && (
                <>
                  <Field label="Written interchange agreement?">
                    <YesNo
                      value={data.trailer_interchange_agreement}
                      onChange={(val) => onChange({ trailer_interchange_agreement: val })}
                      disabled={disabled}
                    />
                  </Field>
                  <Field label="Desired Limit">
                    <input
                      type="text"
                      className={ui.input}
                      value={data.trailer_interchange_limit}
                      onChange={(e) => onChange({ trailer_interchange_limit: e.target.value })}
                      placeholder="e.g. $30,000"
                      disabled={disabled}
                    />
                  </Field>
                  <Field label="Deductible">
                    <input
                      type="text"
                      className={ui.input}
                      value={data.trailer_interchange_deductible}
                      onChange={(e) => onChange({ trailer_interchange_deductible: e.target.value })}
                      placeholder="e.g. $1,000"
                      disabled={disabled}
                    />
                  </Field>
                </>
              )}
            </div>

            {pullsTrailers && data.trailer_interchange_agreement === false && (
              <div className="mt-4">
                <AgentGuidance>
                  Most carriers will not write Trailer Interchange without a written agreement in
                  place. Note who the trailers belong to in the operation description.
                </AgentGuidance>
              </div>
            )}
          </CoverageBlock>

          {/* ─── Additional coverages — collapsed unless selected ────────────── */}
          <details
            className="rounded-2xl border border-slate-100 bg-slate-50/40"
            open={
              data.general_liability_requested === true
              || data.medical_payments_requested === true
              || Boolean(data.additional_coverages_other)
            }
          >
            <summary className="cursor-pointer px-4 py-3 text-xs font-black uppercase tracking-wider text-slate-400">
              Additional coverages (optional)
            </summary>
            <div className="space-y-4 px-4 pb-4">
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Field label="General Liability?">
                  <YesNo
                    value={data.general_liability_requested}
                    onChange={(val) =>
                      onChange({
                        general_liability_requested: val,
                        ...(val === true ? {} : { general_liability_limit: '' }),
                      })
                    }
                    disabled={disabled}
                  />
                </Field>
                {data.general_liability_requested === true && (
                  <Field label="General Liability Limit">
                    <input
                      type="text"
                      className={ui.input}
                      value={data.general_liability_limit}
                      onChange={(e) => onChange({ general_liability_limit: e.target.value })}
                      placeholder="e.g. $1,000,000 / $2,000,000"
                      disabled={disabled}
                    />
                  </Field>
                )}
              </div>

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <Field label="Medical Payments?">
                  <YesNo
                    value={data.medical_payments_requested}
                    onChange={(val) =>
                      onChange({
                        medical_payments_requested: val,
                        ...(val === true ? {} : { medical_payments_limit: '' }),
                      })
                    }
                    disabled={disabled}
                  />
                </Field>
                {data.medical_payments_requested === true && (
                  <Field label="Medical Payments Limit">
                    <input
                      type="text"
                      className={ui.input}
                      value={data.medical_payments_limit}
                      onChange={(e) => onChange({ medical_payments_limit: e.target.value })}
                      placeholder="e.g. $5,000"
                      disabled={disabled}
                    />
                  </Field>
                )}
              </div>

              <Field label="Other coverage requested">
                <textarea
                  rows={2}
                  className={ui.textarea}
                  value={data.additional_coverages_other}
                  onChange={(e) => onChange({ additional_coverages_other: e.target.value })}
                  placeholder="Anything else the customer asked to be quoted"
                  disabled={disabled}
                />
              </Field>
            </div>
          </details>
        </div>
      </div>
    </section>
  );
}
