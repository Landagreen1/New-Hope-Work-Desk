'use client';

import { ClipboardCheck } from 'lucide-react';
import { ui } from '../nhwd-shared/ui';
import { AgentGuidance, Field, YesNo, YesNoNotSure } from './trucking-fields';

/**
 * The underwriting questions every trucking carrier asks, and nothing more.
 *
 * Deliberately short. Carrier-specific supplemental questions belong to the
 * Market Directory, not here — this section exists so Customer Service captures
 * the handful of answers that decide whether a risk is even placeable.
 */
export interface UnderwritingData {
  uw_coverage_lapse: boolean | null;
  uw_coverage_lapse_detail: string;
  uw_cancelled_nonrenewed: boolean | null;
  uw_cancelled_nonrenewed_detail: string;
  uw_losses_3yr: boolean | null;
  uw_losses_3yr_detail: string;
  uw_major_al_loss: boolean | null;
  uw_major_al_loss_detail: string;
  /** Yes / No / Unsure. Shares the pre-existing `hazmat` column. */
  hazmat: string;
  hazmat_detail: string;
  uw_owner_operators: boolean | null;
  uw_owner_operators_detail: string;
  owner_operator_count: number | null;
}

interface UnderwritingSectionProps {
  data: UnderwritingData;
  onChange: (patch: Partial<UnderwritingData>) => void;
  disabled?: boolean;
}

/**
 * One yes/no question with an explanation that only appears when the answer is
 * Yes. This is the whole reason the section stays short on a clean risk.
 */
function Question({
  question,
  value,
  onValueChange,
  detailLabel,
  detail,
  onDetailChange,
  disabled,
  children,
}: {
  question: string;
  value: boolean | null;
  onValueChange: (value: boolean | null) => void;
  detailLabel: string;
  detail: string;
  onDetailChange: (value: string) => void;
  disabled?: boolean;
  /** Extra fields revealed alongside the explanation when the answer is Yes. */
  children?: React.ReactNode;
}) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-xl text-sm font-bold text-slate-800">{question}</p>
        <div className="w-40 shrink-0">
          <YesNo value={value} onChange={onValueChange} disabled={disabled} />
        </div>
      </div>

      {value === true && (
        <div className="mt-4 space-y-3 border-t border-slate-100 pt-3">
          <Field label={detailLabel} required>
            <textarea
              rows={2}
              className={ui.textarea}
              value={detail}
              onChange={(e) => onDetailChange(e.target.value)}
              placeholder="Dates, amounts, carrier and what happened"
              disabled={disabled}
            />
          </Field>
          {children}
        </div>
      )}
    </div>
  );
}

export default function UnderwritingSection({ data, onChange, disabled }: UnderwritingSectionProps) {
  const hazmatFlagged = data.hazmat === 'yes' || data.hazmat === 'unsure';

  return (
    <section className={ui.card}>
      <div className={ui.cardHeader}>
        <div className="flex items-start gap-3">
          <div className="grid h-10 w-10 shrink-0 place-items-center rounded-2xl bg-[#eef3fb] text-[#223f7a]">
            <ClipboardCheck className="h-5 w-5" />
          </div>
          <div>
            <h3 className="text-lg font-black text-slate-950">Underwriting / Eligibility</h3>
            <p className="mt-1 text-sm font-semibold text-slate-500">
              Six questions that decide where this risk can be placed. Details are only asked when
              the answer is Yes.
            </p>
          </div>
        </div>
      </div>

      <div className={ui.cardPad}>
        <div className="space-y-3">
          <AgentGuidance>
            A Yes is not a problem — an unexplained Yes is. Capture dates, amounts and the carrier
            involved so the specialty team does not have to call the customer back.
          </AgentGuidance>

          <Question
            question="Any lapse in coverage during the past 3 years?"
            value={data.uw_coverage_lapse}
            onValueChange={(val) =>
              onChange({
                uw_coverage_lapse: val,
                ...(val === true ? {} : { uw_coverage_lapse_detail: '' }),
              })
            }
            detailLabel="How long was the lapse, and why?"
            detail={data.uw_coverage_lapse_detail}
            onDetailChange={(val) => onChange({ uw_coverage_lapse_detail: val })}
            disabled={disabled}
          />

          <Question
            question="Cancelled or non-renewed during the past 3 years?"
            value={data.uw_cancelled_nonrenewed}
            onValueChange={(val) =>
              onChange({
                uw_cancelled_nonrenewed: val,
                ...(val === true ? {} : { uw_cancelled_nonrenewed_detail: '' }),
              })
            }
            detailLabel="Which carrier, when, and the stated reason"
            detail={data.uw_cancelled_nonrenewed_detail}
            onDetailChange={(val) => onChange({ uw_cancelled_nonrenewed_detail: val })}
            disabled={disabled}
          />

          <Question
            question="Any claims or losses during the past 3 years?"
            value={data.uw_losses_3yr}
            onValueChange={(val) =>
              onChange({
                uw_losses_3yr: val,
                ...(val === true ? {} : { uw_losses_3yr_detail: '' }),
              })
            }
            detailLabel="How many, what type, and roughly what they paid"
            detail={data.uw_losses_3yr_detail}
            onDetailChange={(val) => onChange({ uw_losses_3yr_detail: val })}
            disabled={disabled}
          />

          <Question
            question="Any major Auto Liability loss (over $250,000)?"
            value={data.uw_major_al_loss}
            onValueChange={(val) =>
              onChange({
                uw_major_al_loss: val,
                ...(val === true ? {} : { uw_major_al_loss_detail: '' }),
              })
            }
            detailLabel="Date, amount and whether it is closed"
            detail={data.uw_major_al_loss_detail}
            onDetailChange={(val) => onChange({ uw_major_al_loss_detail: val })}
            disabled={disabled}
          />

          {/* Hazmat allows Unsure, because Customer Service often genuinely does
              not know on the first call and a guessed No is worse than Unsure. */}
          <div className="rounded-2xl border border-slate-200 bg-white p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="max-w-xl text-sm font-bold text-slate-800">
                Hauls hazardous materials?
              </p>
              <div className="w-40 shrink-0">
                <YesNoNotSure
                  value={data.hazmat}
                  onChange={(val) =>
                    onChange({
                      hazmat: val,
                      ...(val === 'yes' || val === 'unsure' ? {} : { hazmat_detail: '' }),
                    })
                  }
                  disabled={disabled}
                />
              </div>
            </div>

            {hazmatFlagged && (
              <div className="mt-4 space-y-3 border-t border-slate-100 pt-3">
                <Field label="What is hauled, and is the customer hazmat certified?" required>
                  <textarea
                    rows={2}
                    className={ui.textarea}
                    value={data.hazmat_detail}
                    onChange={(e) => onChange({ hazmat_detail: e.target.value })}
                    placeholder="e.g. Fuel oil, placarded, driver has H endorsement"
                    disabled={disabled}
                  />
                </Field>
              </div>
            )}
          </div>

          <Question
            question="Uses owner / operators?"
            value={data.uw_owner_operators}
            onValueChange={(val) =>
              onChange({
                uw_owner_operators: val,
                ...(val === true ? {} : { uw_owner_operators_detail: '', owner_operator_count: null }),
              })
            }
            detailLabel="How are they used, and who provides their coverage?"
            detail={data.uw_owner_operators_detail}
            onDetailChange={(val) => onChange({ uw_owner_operators_detail: val })}
            disabled={disabled}
          >
            <Field label="How many owner / operators?">
              <input
                type="number"
                min={0}
                className={ui.input}
                value={data.owner_operator_count ?? ''}
                onChange={(e) =>
                  onChange({
                    owner_operator_count: e.target.value === '' ? null : Number(e.target.value),
                  })
                }
                placeholder="e.g. 3"
                disabled={disabled}
              />
            </Field>
          </Question>
        </div>
      </div>
    </section>
  );
}
