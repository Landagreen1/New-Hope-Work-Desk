'use client';

/**
 * Trailer schedule for the trucking intake (v1.19.2).
 *
 * Trailers are rated separately from power units, so they cannot live in the
 * Vehicles repeater. Carriers need a year, type and value per trailer to quote
 * Physical Damage on them at all.
 *
 * The whole section is gated behind one question, so a tractor-only or
 * straight-truck operation never sees it. Non-owned trailers the insured pulls
 * under an interchange agreement are NOT scheduled here — those are covered by
 * Trailer Interchange in Requested Coverages.
 */

import { Container, Plus, Trash2 } from 'lucide-react';

import { ui } from '../nhwd-shared/ui';
import type { CsIntakeTrailer } from './api';
import { AgentGuidance, Field, MoneyInput, YesNo } from './trucking-fields';

/** Trailer body types, mirroring the Truck Type list on the Vehicles repeater. */
export const TRAILER_TYPES: readonly { key: string; label: string }[] = [
  { key: 'dry_van', label: 'Dry Van' },
  { key: 'flatbed', label: 'Flatbed' },
  { key: 'reefer', label: 'Reefer / Refrigerated' },
  { key: 'tanker', label: 'Tanker' },
  { key: 'dump', label: 'Dump Trailer' },
  { key: 'lowboy', label: 'Lowboy' },
  { key: 'step_deck', label: 'Step Deck' },
  { key: 'car_hauler', label: 'Car Hauler' },
  { key: 'utility', label: 'Utility' },
  { key: 'other', label: 'Other' },
];

export function emptyTrailer(position = 1): CsIntakeTrailer {
  return {
    position,
    year: null,
    make: null,
    trailer_type: null,
    vin: null,
    actual_cash_value: null,
    ownership: 'owned',
    lessor_name: null,
    lessor_address: null,
  };
}

/** Human label for a stored trailer type key. Used by the carrier PDF adapter. */
export function trailerTypeLabel(key: string | null | undefined): string {
  if (!key) return '';
  return TRAILER_TYPES.find((type) => type.key === key)?.label ?? key;
}

interface TrailersSectionProps {
  /** `cs_intake_submissions.owns_or_leases_trailers` — the gate for this section. */
  ownsOrLeasesTrailers: boolean | null;
  onOwnsChange: (value: boolean | null) => void;
  trailers: CsIntakeTrailer[];
  onTrailersChange: (rows: CsIntakeTrailer[]) => void;
  /**
   * `pulls_non_owned_trailers` from Requested Coverages. Used only to explain
   * why a customer who pulls other people's trailers may still answer No here.
   */
  pullsNonOwnedTrailers?: boolean | null;
  readOnly?: boolean;
  disabled?: boolean;
}

export default function TrailersSection({
  ownsOrLeasesTrailers,
  onOwnsChange,
  trailers,
  onTrailersChange,
  pullsNonOwnedTrailers,
  readOnly,
  disabled,
}: TrailersSectionProps) {
  /**
   * Flipping the gate seeds the first row (so the agent is not left staring at
   * an empty card) and clearing it drops the schedule, so a No can never be
   * saved alongside orphaned trailers.
   */
  const setGate = (value: boolean | null) => {
    onOwnsChange(value);
    if (value === true) {
      if (!trailers.length) onTrailersChange([emptyTrailer(1)]);
    } else {
      onTrailersChange([]);
    }
  };

  const patchTrailer = (index: number, values: Partial<CsIntakeTrailer>) => {
    onTrailersChange(trailers.map((row, rowIndex) => (rowIndex === index ? { ...row, ...values } : row)));
  };

  const removeTrailer = (index: number) => {
    onTrailersChange(
      trailers
        .filter((_, rowIndex) => rowIndex !== index)
        .map((row, rowIndex) => ({ ...row, position: rowIndex + 1 })),
    );
  };

  const addTrailer = () => {
    onTrailersChange([...trailers, emptyTrailer(trailers.length + 1)]);
  };

  const scheduledValue = trailers.reduce((total, row) => total + (row.actual_cash_value ?? 0), 0);

  return (
    <section className={ui.card}>
      <div className={ui.cardHeader}>
        <div className="flex items-start gap-3">
          <div className="grid h-10 w-10 shrink-0 place-items-center rounded-2xl bg-[#eef3fb] text-[#223f7a]">
            <Container className="h-5 w-5" />
          </div>
          <div>
            <h3 className="text-lg font-black text-slate-950">
              Trailers{ownsOrLeasesTrailers === true && trailers.length ? ` (${trailers.length})` : ''}
            </h3>
            <p className="mt-1 text-sm font-semibold text-slate-500">
              Trailers are rated separately from the trucks. Only asked if the customer owns or
              leases any.
            </p>
          </div>
        </div>
      </div>

      <div className={ui.cardPad}>
        <div className="space-y-4">
          <div className="rounded-2xl border border-[#c9d5e9] bg-[#f8faff] p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="max-w-xl text-sm font-bold text-slate-800">
                Does the customer own or lease any trailers?
              </p>
              <div className="w-40 shrink-0">
                <YesNo value={ownsOrLeasesTrailers} onChange={setGate} disabled={disabled} />
              </div>
            </div>
          </div>

          {ownsOrLeasesTrailers === false && pullsNonOwnedTrailers === true && (
            <AgentGuidance>
              This customer pulls trailers they do not own. Those are covered by Trailer Interchange
              under Requested Coverages, not scheduled here — so No is the right answer.
            </AgentGuidance>
          )}

          {ownsOrLeasesTrailers === true && (
            <>
              <AgentGuidance>
                One row per trailer. The value matters most — carriers cannot quote trailer Physical
                Damage without it. A VIN is helpful but not required to submit.
              </AgentGuidance>

              <div className="space-y-4">
                {trailers.map((trailer, index) => (
                  <div
                    key={trailer.id || `trailer-${index}`}
                    className="rounded-2xl border border-slate-200 bg-slate-50/70 p-4"
                  >
                    <div className="flex items-center justify-between gap-3">
                      <p className="font-black text-slate-900">Trailer {index + 1}</p>
                      {!readOnly && trailers.length > 1 ? (
                        <button type="button" className={ui.btnDanger} onClick={() => removeTrailer(index)}>
                          <Trash2 className="h-4 w-4" /> Remove
                        </button>
                      ) : null}
                    </div>

                    <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                      <Field label="Year">
                        <input
                          type="number"
                          min="1900"
                          max="2100"
                          className={ui.input}
                          disabled={disabled}
                          value={trailer.year ?? ''}
                          onChange={(event) =>
                            patchTrailer(index, {
                              year: event.target.value === '' ? null : Number(event.target.value),
                            })
                          }
                        />
                      </Field>

                      <Field label="Make">
                        <input
                          className={ui.input}
                          disabled={disabled}
                          value={trailer.make || ''}
                          onChange={(event) => patchTrailer(index, { make: event.target.value || null })}
                          placeholder="e.g. Great Dane"
                        />
                      </Field>

                      <Field label="Trailer type">
                        <select
                          className={ui.select}
                          disabled={disabled}
                          value={trailer.trailer_type || ''}
                          onChange={(event) =>
                            patchTrailer(index, { trailer_type: event.target.value || null })
                          }
                        >
                          <option value="">Select</option>
                          {TRAILER_TYPES.map((type) => (
                            <option key={type.key} value={type.key}>
                              {type.label}
                            </option>
                          ))}
                        </select>
                      </Field>

                      <Field label="VIN" hint="Optional, but carriers ask for it before binding.">
                        <input
                          className={ui.input}
                          disabled={disabled}
                          value={trailer.vin || ''}
                          onChange={(event) =>
                            patchTrailer(index, { vin: event.target.value.toUpperCase() || null })
                          }
                        />
                      </Field>

                      <Field label="Actual cash value" hint="What the trailer is worth today.">
                        <MoneyInput
                          value={trailer.actual_cash_value}
                          onChange={(value) => patchTrailer(index, { actual_cash_value: value })}
                          placeholder="e.g. 20000"
                          disabled={disabled}
                        />
                      </Field>

                      <Field label="Ownership">
                        <select
                          className={ui.select}
                          disabled={disabled}
                          value={trailer.ownership || 'owned'}
                          onChange={(event) => patchTrailer(index, { ownership: event.target.value })}
                        >
                          <option value="owned">Owned</option>
                          <option value="financed">Financed</option>
                          <option value="leased">Leased</option>
                        </select>
                      </Field>

                      {trailer.ownership === 'leased' && (
                        <>
                          <Field
                            label="Lessor name"
                            hint="Usually listed as an additional insured or loss payee."
                          >
                            <input
                              className={ui.input}
                              disabled={disabled}
                              value={trailer.lessor_name || ''}
                              onChange={(event) =>
                                patchTrailer(index, { lessor_name: event.target.value || null })
                              }
                            />
                          </Field>

                          <Field label="Lessor address">
                            <input
                              className={ui.input}
                              disabled={disabled}
                              value={trailer.lessor_address || ''}
                              onChange={(event) =>
                                patchTrailer(index, { lessor_address: event.target.value || null })
                              }
                            />
                          </Field>
                        </>
                      )}
                    </div>
                  </div>
                ))}
              </div>

              {scheduledValue > 0 && (
                <div className="rounded-2xl border border-slate-200 bg-white p-4">
                  <p className="text-xs font-black uppercase tracking-wider text-slate-500">
                    Total scheduled trailer value
                  </p>
                  <p className="mt-1 text-lg font-black text-slate-900">
                    ${scheduledValue.toLocaleString()}
                  </p>
                </div>
              )}

              {!readOnly ? (
                <button type="button" className={ui.btnSecondary} onClick={addTrailer}>
                  <Plus className="h-4 w-4" /> Add another trailer
                </button>
              ) : null}
            </>
          )}
        </div>
      </div>
    </section>
  );
}
