'use client';

/**
 * Editing one driver or one unit.
 *
 * `specialty_update_intake` replaces the whole driver or vehicle list when it is given one
 * — that is how the intake form itself saves them — so these editors send every row back
 * with only the edited one changed. That array is built by `applyRow` in `row-payload.ts`,
 * which is where the two rules that make it safe are written down and tested.
 *
 * Both dialogs can also add and remove a row, because "no drivers listed" is a real state a
 * specialty member has to be able to fix without going back to Customer Service.
 *
 * The three-way controls here are three-way on purpose. `cdl`, `owner_operator`,
 * `accidents_36mo` and `violations_36mo` are nullable, and null means nobody has asked yet
 * — an application that answers "no accidents" when the question was never put to the
 * insured is worse than one that leaves it blank. `sr22_required` and `vin_pending` are NOT
 * NULL, so those two are plain Yes/No.
 */

import { Trash2 } from 'lucide-react';
import { useState } from 'react';

import DollarInput from '../../nhwd-shared/DollarInput';
import { ui } from '../../nhwd-shared/ui';
import { updateLinkedIntake } from '../api';
import type { LinkedIntake } from '../types';
import { applyRow, rowTarget, type RawRow, type RowTarget } from './row-payload';
import { EditModal, Field, type Runner } from './shared';

const TRUCK_TYPES = [
  { value: 'box_truck', label: 'Box Truck' },
  { value: 'truck_tractor', label: 'Truck Tractor' },
  { value: 'sprinter_van', label: 'Sprinter Van' },
  { value: 'flatbed', label: 'Flatbed' },
  { value: 'reefer', label: 'Reefer' },
  { value: 'tanker', label: 'Tanker' },
  { value: 'dump_truck', label: 'Dump Truck' },
  { value: 'car_hauler', label: 'Car Hauler' },
  { value: 'step_van', label: 'Step Van' },
  { value: 'other', label: 'Other' },
] as const;

const OWNERSHIP = [
  { value: 'owned', label: 'Owned' },
  { value: 'financed', label: 'Financed' },
  { value: 'leased', label: 'Leased' },
] as const;

const VEHICLE_COVERAGE = [
  { value: 'full_coverage', label: 'Full Coverage' },
  { value: 'liability_only', label: 'Liability Only' },
] as const;

const LICENCE_STATUS = [
  { value: 'valid', label: 'Valid' },
  { value: 'permit', label: 'Permit' },
  { value: 'foreign', label: 'Foreign' },
  { value: 'suspended', label: 'Suspended' },
  { value: 'not_licensed', label: 'Not licensed / ID only' },
] as const;

const DOCUMENT_TYPES = [
  { value: 'driver_license', label: 'Driver licence' },
  { value: 'state_id', label: 'State ID' },
  { value: 'passport', label: 'Passport' },
] as const;

const RELATIONSHIPS = [
  { value: 'self', label: 'Self' },
  { value: 'spouse', label: 'Spouse' },
  { value: 'child', label: 'Child' },
  { value: 'employee', label: 'Employee' },
  { value: 'other', label: 'Other' },
] as const;

function text(value: unknown): string {
  return value === null || value === undefined ? '' : String(value);
}

function TriState({
  value,
  onChange,
}: {
  value: boolean | null | undefined;
  onChange: (next: boolean | null) => void;
}) {
  return (
    <select
      className={ui.select}
      value={value === null || value === undefined ? '' : String(value)}
      onChange={(event) =>
        onChange(event.target.value === '' ? null : event.target.value === 'true')
      }
    >
      <option value="">Not recorded</option>
      <option value="true">Yes</option>
      <option value="false">No</option>
    </select>
  );
}

// ── Drivers ──────────────────────────────────────────────────────────────────

export function DriverDialog({
  intake,
  opportunityId,
  /** Null adds a driver; otherwise the index in `intake.drivers` being edited. */
  index,
  run,
  busy,
  onClose,
}: {
  intake: LinkedIntake;
  opportunityId: string;
  index: number | null;
  run: Runner;
  busy: boolean;
  onClose: () => void;
}) {
  const rows = intake.drivers as unknown as RawRow[];
  const existing = index === null ? null : rows[index];

  const [draft, setDraft] = useState<RawRow>(() =>
    existing
      ? { ...existing }
      : {
          position: rows.length + 1,
          first_name: '',
          last_name: '',
          document_type: 'driver_license',
          license_status: 'valid',
          relationship: rows.length === 0 ? 'self' : 'other',
          sr22_required: false,
          incidents: [],
        },
  );
  /** Which row this is, and the version it was read at. Both captured together. */
  const [target] = useState<RowTarget>(() => rowTarget(existing));
  const [seededVersion] = useState(intake.version);
  const [staleError, setStaleError] = useState<string | null>(null);

  const set = (key: string, value: unknown) =>
    setDraft((current) => ({ ...current, [key]: value }));

  const who =
    `${text(draft.first_name)} ${text(draft.last_name)}`.trim() ||
    (index === null ? 'a new driver' : `driver ${index + 1}`);

  const save = (removing: boolean) => {
    const next = applyRow(rows, target, draft, removing);
    if (next === null) {
      setStaleError(
        `${who} is no longer on this quote — a teammate changed the driver list while this was open. Close this and reopen it.`,
      );
      return;
    }

    void run(async () => {
      await updateLinkedIntake(opportunityId, {}, seededVersion, { drivers: next });
    }, removing ? `${who} was removed.` : `${who} was saved.`).then((ok) => {
      if (ok) onClose();
    });
  };

  return (
    <EditModal
      title={index === null ? 'Add a driver' : `Edit ${who}`}
      description="Saved to the Customer Service intake. Every other driver on this quote is passed through unchanged, including their incident history."
      onClose={onClose}
      busy={busy}
      wide
      error={staleError}
      submitDisabled={text(draft.first_name).trim() === '' && text(draft.last_name).trim() === ''}
      onSubmit={() => save(false)}
    >
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="First name">
          <input
            className={ui.input}
            value={text(draft.first_name)}
            onChange={(event) => set('first_name', event.target.value)}
          />
        </Field>
        <Field label="Last name">
          <input
            className={ui.input}
            value={text(draft.last_name)}
            onChange={(event) => set('last_name', event.target.value)}
          />
        </Field>
        <Field label="Date of birth">
          <input
            className={ui.input}
            type="date"
            value={text(draft.dob).slice(0, 10)}
            onChange={(event) => set('dob', event.target.value || null)}
          />
        </Field>

        <Field label="Relationship">
          <select
            className={ui.select}
            value={text(draft.relationship) || 'other'}
            onChange={(event) => set('relationship', event.target.value)}
          >
            {RELATIONSHIPS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Document type">
          <select
            className={ui.select}
            value={text(draft.document_type) || 'driver_license'}
            onChange={(event) => set('document_type', event.target.value)}
          >
            {DOCUMENT_TYPES.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Licence status">
          <select
            className={ui.select}
            value={text(draft.license_status) || 'valid'}
            onChange={(event) => set('license_status', event.target.value)}
          >
            {LICENCE_STATUS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Licence number">
          <input
            className={ui.input}
            value={text(draft.license_number)}
            onChange={(event) => set('license_number', event.target.value || null)}
          />
        </Field>
        <Field label="Licence state">
          <input
            className={ui.input}
            value={text(draft.license_state)}
            onChange={(event) => set('license_state', event.target.value || null)}
          />
        </Field>
        <Field label="Years licensed">
          <input
            className={ui.input}
            type="number"
            value={text(draft.years_licensed)}
            onChange={(event) =>
              set('years_licensed', event.target.value === '' ? null : Number(event.target.value))
            }
          />
        </Field>

        <Field label="Holds a CDL?">
          <TriState value={draft.cdl as boolean | null} onChange={(next) => set('cdl', next)} />
        </Field>
        <Field label="CDL issued">
          <input
            className={ui.input}
            type="date"
            value={text(draft.cdl_date).slice(0, 10)}
            onChange={(event) => set('cdl_date', event.target.value || null)}
          />
        </Field>
        <Field
          label="Years of commercial experience"
          hint="The answer underwriters send an application back for."
        >
          <input
            className={ui.input}
            type="number"
            value={text(draft.cdl_years_experience)}
            onChange={(event) =>
              set(
                'cdl_years_experience',
                event.target.value === '' ? null : Number(event.target.value),
              )
            }
          />
        </Field>

        <Field label="Owner-operator?">
          <TriState
            value={draft.owner_operator as boolean | null}
            onChange={(next) => set('owner_operator', next)}
          />
        </Field>
        {/* Yes/No, not three-way: the column is NOT NULL, so there is no "unanswered"
            state for the database to keep and offering one would be a lie. */}
        <Field label="SR-22 required?">
          <select
            className={ui.select}
            value={draft.sr22_required === true ? 'true' : 'false'}
            onChange={(event) => set('sr22_required', event.target.value === 'true')}
          >
            <option value="false">No</option>
            <option value="true">Yes</option>
          </select>
        </Field>
        <div />

        <Field label="Accidents in 36 months?">
          <TriState
            value={draft.accidents_36mo as boolean | null}
            onChange={(next) => set('accidents_36mo', next)}
          />
        </Field>
        <div className="sm:col-span-2">
          <Field label="Accident detail">
            <input
              className={ui.input}
              value={text(draft.accidents_detail)}
              onChange={(event) => set('accidents_detail', event.target.value || null)}
            />
          </Field>
        </div>

        <Field label="Violations in 36 months?">
          <TriState
            value={draft.violations_36mo as boolean | null}
            onChange={(next) => set('violations_36mo', next)}
          />
        </Field>
        <div className="sm:col-span-2">
          <Field label="Violation detail">
            <input
              className={ui.input}
              value={text(draft.violations_detail)}
              onChange={(event) => set('violations_detail', event.target.value || null)}
            />
          </Field>
        </div>
      </div>

      {index !== null ? (
        <div className="mt-5 border-t border-slate-100 pt-4">
          <button
            type="button"
            className={ui.btnDanger}
            disabled={busy}
            onClick={() => save(true)}
          >
            <Trash2 className="h-4 w-4" />
            Remove this driver
          </button>
        </div>
      ) : null}
    </EditModal>
  );
}

// ── Units ────────────────────────────────────────────────────────────────────

export function VehicleDialog({
  intake,
  opportunityId,
  index,
  isTrucking,
  run,
  busy,
  onClose,
}: {
  intake: LinkedIntake;
  opportunityId: string;
  index: number | null;
  isTrucking: boolean;
  run: Runner;
  busy: boolean;
  onClose: () => void;
}) {
  const rows = intake.vehicles as unknown as RawRow[];
  const existing = index === null ? null : rows[index];

  const [draft, setDraft] = useState<RawRow>(() =>
    existing
      ? { ...existing }
      : {
          position: rows.length + 1,
          vin_pending: false,
          ownership: 'owned',
          coverage: {},
        },
  );
  const [target] = useState<RowTarget>(() => rowTarget(existing));
  const [seededVersion] = useState(intake.version);
  const [staleError, setStaleError] = useState<string | null>(null);

  const set = (key: string, value: unknown) =>
    setDraft((current) => ({ ...current, [key]: value }));

  const who =
    [text(draft.year), text(draft.make), text(draft.model)].filter(Boolean).join(' ') ||
    (index === null ? 'a new unit' : `unit ${index + 1}`);

  const save = (removing: boolean) => {
    const next = applyRow(rows, target, draft, removing);
    if (next === null) {
      setStaleError(
        `${who} is no longer on this quote — a teammate changed the unit list while this was open. Close this and reopen it.`,
      );
      return;
    }

    void run(async () => {
      await updateLinkedIntake(opportunityId, {}, seededVersion, { vehicles: next });
    }, removing ? `${who} was removed.` : `${who} was saved.`).then((ok) => {
      if (ok) onClose();
    });
  };

  return (
    <EditModal
      title={index === null ? 'Add a unit' : `Edit ${who}`}
      description="Saved to the Customer Service intake. Every other unit is passed through unchanged."
      onClose={onClose}
      busy={busy}
      wide
      error={staleError}
      onSubmit={() => save(false)}
    >
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="Year">
          <input
            className={ui.input}
            type="number"
            value={text(draft.year)}
            onChange={(event) =>
              set('year', event.target.value === '' ? null : Number(event.target.value))
            }
          />
        </Field>
        <Field label="Make">
          <input
            className={ui.input}
            value={text(draft.make)}
            onChange={(event) => set('make', event.target.value || null)}
          />
        </Field>
        <Field label="Model">
          <input
            className={ui.input}
            value={text(draft.model)}
            onChange={(event) => set('model', event.target.value || null)}
          />
        </Field>

        <div className="sm:col-span-2">
          <Field label="VIN">
            <input
              className={ui.input}
              value={text(draft.vin)}
              onChange={(event) => set('vin', event.target.value || null)}
            />
          </Field>
        </div>
        {/* NOT NULL on the table, so Yes/No rather than three-way. */}
        <Field label="VIN still to come?">
          <select
            className={ui.select}
            value={draft.vin_pending === true ? 'true' : 'false'}
            onChange={(event) => set('vin_pending', event.target.value === 'true')}
          >
            <option value="false">No</option>
            <option value="true">Yes</option>
          </select>
        </Field>

        {isTrucking ? (
          <Field label="Truck type">
            <select
              className={ui.select}
              value={text(draft.truck_type)}
              onChange={(event) => set('truck_type', event.target.value || null)}
            >
              <option value="">Not recorded</option>
              {TRUCK_TYPES.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </Field>
        ) : null}
        <Field label="Ownership">
          <select
            className={ui.select}
            value={text(draft.ownership) || 'owned'}
            onChange={(event) => set('ownership', event.target.value)}
          >
            {OWNERSHIP.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Coverage type">
          <select
            className={ui.select}
            value={text(draft.coverage_type)}
            onChange={(event) => set('coverage_type', event.target.value || null)}
          >
            <option value="">Not recorded</option>
            {VEHICLE_COVERAGE.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </Field>

        {isTrucking ? (
          <>
            <Field label="Stated value" hint="What Physical Damage is rated on.">
              <DollarInput
                value={(draft.physical_damage_value as number | null) ?? null}
                onChange={(next) => set('physical_damage_value', next)}
              />
            </Field>
            <Field label="Physical Damage deductible">
              <DollarInput
                value={(draft.physical_damage_deductible as number | null) ?? null}
                onChange={(next) => set('physical_damage_deductible', next)}
              />
            </Field>
            <div />
          </>
        ) : null}

        <Field label="Lienholder">
          <input
            className={ui.input}
            value={text(draft.lienholder)}
            onChange={(event) => set('lienholder', event.target.value || null)}
          />
        </Field>
        <Field label="Lessor name">
          <input
            className={ui.input}
            value={text(draft.lessor_name)}
            onChange={(event) => set('lessor_name', event.target.value || null)}
          />
        </Field>
        <Field label="Lessor address">
          <input
            className={ui.input}
            value={text(draft.lessor_address)}
            onChange={(event) => set('lessor_address', event.target.value || null)}
          />
        </Field>

        <Field label="Usage">
          <input
            className={ui.input}
            value={text(draft.usage)}
            onChange={(event) => set('usage', event.target.value || null)}
          />
        </Field>
        <Field label="Annual mileage">
          <input
            className={ui.input}
            type="number"
            value={text(draft.annual_mileage)}
            onChange={(event) =>
              set('annual_mileage', event.target.value === '' ? null : Number(event.target.value))
            }
          />
        </Field>
        <Field label="Garaging ZIP">
          <input
            className={ui.input}
            value={text(draft.garaging_zip)}
            onChange={(event) => set('garaging_zip', event.target.value || null)}
          />
        </Field>
      </div>

      {index !== null ? (
        <div className="mt-5 border-t border-slate-100 pt-4">
          <button
            type="button"
            className={ui.btnDanger}
            disabled={busy}
            onClick={() => save(true)}
          >
            <Trash2 className="h-4 w-4" />
            Remove this unit
          </button>
        </div>
      ) : null}
    </EditModal>
  );
}
