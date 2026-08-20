'use client';

/**
 * The Application tab — the master specialty intake.
 *
 * One application, not one per carrier. Everything shown here is read live from the
 * linked Customer Service intake and every correction is written back to it, so there
 * is no second copy of a customer's business name to go stale. A carrier's own
 * questions live on that carrier, under Carriers.
 *
 * Sections are collapsed by default and each one carries its state, its summary and
 * the gaps an underwriter would send it back for. That is the trade the redesign is
 * making: fifty fields on screen at once is not information, it is a wall, so a
 * section opens when somebody asks for it.
 *
 * Cargo gets the most room. "Dry Freight" is what actually gets typed into the old
 * free-text field and it is not something a carrier can rate, so the structured
 * category, the commodity mix, the per-load values and the prohibited-cargo answers
 * are all shown by name — and named as missing when they are absent.
 */

import { AlertTriangle, Check, ChevronDown, Circle, Pencil, Plus, Truck } from 'lucide-react';
import { useState } from 'react';

import { ui } from '../../nhwd-shared/ui';
import {
  applicationSections,
  cargoProfile,
  radiusBandLabel,
  requestedCoverage,
  yesNoUnsure,
  type ApplicationSection,
  type SectionKey,
} from '../application';
import { formatMoney, formatPhone, lineLabel, titleCase } from '../status';
import type { LinkedIntake, OpportunityDetail } from '../types';
import IntakeEditDialog from './IntakeEditDialog';
import { DriverDialog, VehicleDialog } from './RowEditors';
import { Badge, MissingList, ReadRow, SectionCard, type Runner } from './shared';

type OpenEditor =
  | { kind: 'section'; section: SectionKey; label: string }
  | { kind: 'driver'; index: number | null }
  | { kind: 'vehicle'; index: number | null }
  | null;

export default function ApplicationPanel({
  detail,
  run,
  busy,
}: {
  detail: OpportunityDetail;
  run: Runner;
  busy: boolean;
}) {
  const { opportunity, intake } = detail;
  const [open, setOpen] = useState<Set<SectionKey>>(new Set());
  const [editor, setEditor] = useState<OpenEditor>(null);

  const canEdit = detail.can_edit && opportunity.result === null;
  const isTrucking = opportunity.line_of_business === 'trucking';

  if (!intake) {
    return (
      <SectionCard title="No linked intake">
        <p className="text-sm font-semibold text-slate-600">
          This quote was migrated from the Commercial Board and has no Customer Service intake behind
          it. The original card&rsquo;s customer detail was preserved as the first note on the quote,
          which is where to read it. Carrier submissions, pricing and documents all work normally.
        </p>
      </SectionCard>
    );
  }

  const sections = applicationSections(opportunity.line_of_business, intake);

  const toggle = (key: SectionKey) =>
    setOpen((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className={ui.sectionTitle}>{lineLabel(opportunity.line_of_business)} application</p>
          <p className="mt-1 text-xs font-semibold text-slate-500">
            Read live from the Customer Service intake — there is no second copy here. Corrections are
            written to that intake, so Customer Service and the specialty team never disagree about a
            phone number.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {sections.map((section) => (
            <button
              key={section.key}
              type="button"
              onClick={() => {
                setOpen(new Set([section.key]));
                document
                  .getElementById(`application-${section.key}`)
                  ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
              }}
              className={`inline-flex items-center gap-1.5 rounded-xl px-2.5 py-1.5 text-xs font-black transition ${
                section.state === 'complete'
                  ? 'bg-emerald-50 text-emerald-700 hover:bg-emerald-100'
                  : section.state === 'attention'
                    ? 'bg-amber-50 text-amber-800 hover:bg-amber-100'
                    : 'bg-slate-100 text-slate-500 hover:bg-slate-200'
              }`}
            >
              <StateGlyph state={section.state} />
              {section.label}
            </button>
          ))}
        </div>
      </div>

      {sections.map((section) => (
        <SectionRow
          key={section.key}
          section={section}
          isOpen={open.has(section.key)}
          onToggle={() => toggle(section.key)}
          onEdit={
            canEdit && section.key !== 'drivers' && section.key !== 'vehicles'
              ? () => setEditor({ kind: 'section', section: section.key, label: section.label })
              : undefined
          }
        >
          {section.key === 'customer' ? <CustomerBody intake={intake} /> : null}
          {section.key === 'business' ? <BusinessBody intake={intake} /> : null}
          {section.key === 'operations' ? <OperationsBody intake={intake} /> : null}
          {section.key === 'property' ? <PropertyBody intake={intake} /> : null}
          {section.key === 'cargo' ? <CargoBody intake={intake} /> : null}
          {section.key === 'coverage' ? (
            <CoverageBody detail={detail} intake={intake} />
          ) : null}
          {section.key === 'prior_insurance' ? <PriorInsuranceBody intake={intake} /> : null}
          {section.key === 'loss_history' ? (
            <LossHistoryBody intake={intake} isTrucking={isTrucking} />
          ) : null}
          {section.key === 'drivers' ? (
            <DriversBody
              intake={intake}
              canEdit={canEdit}
              onEdit={(index) => setEditor({ kind: 'driver', index })}
            />
          ) : null}
          {section.key === 'vehicles' ? (
            <VehiclesBody
              intake={intake}
              isTrucking={isTrucking}
              canEdit={canEdit}
              onEdit={(index) => setEditor({ kind: 'vehicle', index })}
            />
          ) : null}
        </SectionRow>
      ))}

      {editor?.kind === 'section' ? (
        <IntakeEditDialog
          section={editor.section}
          sectionLabel={editor.label}
          line={opportunity.line_of_business}
          intake={intake}
          opportunityId={opportunity.id}
          run={run}
          busy={busy}
          onClose={() => setEditor(null)}
        />
      ) : null}
      {editor?.kind === 'driver' ? (
        <DriverDialog
          intake={intake}
          opportunityId={opportunity.id}
          index={editor.index}
          run={run}
          busy={busy}
          onClose={() => setEditor(null)}
        />
      ) : null}
      {editor?.kind === 'vehicle' ? (
        <VehicleDialog
          intake={intake}
          opportunityId={opportunity.id}
          index={editor.index}
          isTrucking={isTrucking}
          run={run}
          busy={busy}
          onClose={() => setEditor(null)}
        />
      ) : null}
    </div>
  );
}

// ── Section chrome ───────────────────────────────────────────────────────────

function StateGlyph({ state }: { state: ApplicationSection['state'] }) {
  if (state === 'complete') return <Check className="h-3.5 w-3.5" strokeWidth={3} />;
  if (state === 'attention') return <AlertTriangle className="h-3.5 w-3.5" strokeWidth={3} />;
  return <Circle className="h-3.5 w-3.5" strokeWidth={3} />;
}

function SectionRow({
  section,
  isOpen,
  onToggle,
  onEdit,
  children,
}: {
  section: ApplicationSection;
  isOpen: boolean;
  onToggle: () => void;
  onEdit?: () => void;
  children: React.ReactNode;
}) {
  return (
    <section id={`application-${section.key}`} className={ui.card}>
      <div className="flex flex-wrap items-center gap-3 px-5 py-4 sm:px-6">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={isOpen}
          className="flex min-w-0 flex-1 items-center gap-3 text-left"
        >
          <span
            aria-hidden
            className={`grid h-7 w-7 shrink-0 place-items-center rounded-xl ${
              section.state === 'complete'
                ? 'bg-emerald-50 text-emerald-600'
                : section.state === 'attention'
                  ? 'bg-amber-50 text-amber-600'
                  : 'bg-slate-100 text-slate-400'
            }`}
          >
            <StateGlyph state={section.state} />
          </span>
          <span className="min-w-0">
            <span className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-black text-slate-900">{section.label}</span>
              {section.missing.length > 0 ? (
                <Badge tone="danger">
                  {section.missing.length} to answer
                </Badge>
              ) : null}
            </span>
            <span className="mt-0.5 block truncate text-xs font-bold text-slate-500">
              {section.summary}
            </span>
          </span>
          <ChevronDown
            className={`ml-auto h-4 w-4 shrink-0 text-slate-300 transition ${isOpen ? 'rotate-180' : ''}`}
            aria-hidden
          />
        </button>
        {onEdit ? (
          <button type="button" className={ui.btnSecondary} onClick={onEdit}>
            <Pencil className="h-3.5 w-3.5" />
            Edit
          </button>
        ) : null}
      </div>

      {isOpen ? (
        <div className="border-t border-slate-100 p-5 sm:p-6">
          {section.missing.length > 0 ? (
            <div className="mb-4">
              <MissingList items={section.missing} title="Still to answer" />
            </div>
          ) : null}
          {children}
        </div>
      ) : null}
    </section>
  );
}

// ── Section bodies ───────────────────────────────────────────────────────────

function CustomerBody({ intake }: { intake: LinkedIntake }) {
  return (
    <div className="grid gap-x-8 sm:grid-cols-2">
      <div>
        <ReadRow
          label="Name"
          value={[intake.insured_first_name, intake.insured_middle_name, intake.insured_last_name]
            .filter(Boolean)
            .join(' ')}
        />
        <ReadRow label="Date of birth" value={intake.insured_dob} />
        <ReadRow label="Phone" value={formatPhone(intake.insured_phone_primary)} />
        <ReadRow label="Alt phone" value={formatPhone(intake.insured_phone_alt)} />
        <ReadRow label="Email" value={intake.insured_email} />
      </div>
      <div>
        <ReadRow
          label="Mailing address"
          value={[
            intake.addr_street,
            intake.addr_unit,
            intake.addr_city,
            `${intake.addr_state ?? ''} ${intake.addr_zip ?? ''}`,
          ]
            .filter((part) => part && part.trim())
            .join(', ')}
        />
        <ReadRow label="Language" value={intake.preferred_language} />
        <ReadRow label="Preferred contact" value={intake.preferred_contact} />
        <ReadRow label="Intake taken by" value={intake.created_by_name} />
        <ReadRow label="Notes from Customer Service" value={intake.csr_notes} />
      </div>
    </div>
  );
}

function BusinessBody({ intake }: { intake: LinkedIntake }) {
  return (
    <div className="grid gap-x-8 sm:grid-cols-2">
      <div>
        <ReadRow label="Business" value={intake.business_name} />
        <ReadRow label="FEIN" value={intake.ein} />
        <ReadRow label="Years in business" value={intake.years_in_business} />
      </div>
      <div>
        <ReadRow label="DOT" value={intake.dot_number} />
        <ReadRow label="MC" value={intake.mc_number} />
        <ReadRow label="MCS-150" value={intake.mcs150_date} />
      </div>
    </div>
  );
}

function OperationsBody({ intake }: { intake: LinkedIntake }) {
  return (
    <>
      {intake.operation_description ? (
        <p className="mb-4 rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm font-semibold text-slate-700">
          {intake.operation_description}
        </p>
      ) : null}
      <div className="grid gap-x-8 sm:grid-cols-2">
        <div>
          <ReadRow
            label="Operations"
            value={(intake.operation_types ?? []).map(titleCase).join(', ')}
          />
          <ReadRow label="Legacy type" value={intake.business_type} />
          <ReadRow label="Radius" value={radiusBandLabel(intake.radius_band)} />
          <ReadRow
            label="Radius (miles)"
            value={intake.operating_radius_miles === null ? null : `${intake.operating_radius_miles} mi`}
          />
          <ReadRow label="Farthest states / cities" value={intake.farthest_states_cities} />
          <ReadRow label="States of operation" value={intake.states_of_operation} />
        </div>
        <div>
          <ReadRow label="Power units" value={intake.power_unit_count} />
          <ReadRow
            label="Interstate"
            value={intake.interstate === null ? null : intake.interstate ? 'Yes' : 'No'}
          />
          <ReadRow
            label="For hire"
            value={intake.for_hire === null ? null : intake.for_hire ? 'Yes' : 'No'}
          />
          <ReadRow
            label="Owns / leases trailers"
            value={
              intake.owns_or_leases_trailers === null
                ? null
                : intake.owns_or_leases_trailers
                  ? 'Yes'
                  : 'No'
            }
          />
          <ReadRow label="Owner-operators" value={intake.owner_operator_count} />
          <ReadRow label="Desired effective date" value={intake.desired_effective_date} />
        </div>
      </div>
    </>
  );
}

function PropertyBody({ intake }: { intake: LinkedIntake }) {
  return (
    <div className="grid gap-x-8 sm:grid-cols-2">
      <div>
        <ReadRow
          label="Property"
          value={
            intake.property_formatted ??
            [
              intake.property_address_street,
              intake.property_address_unit,
              intake.property_address_city,
              `${intake.property_address_state ?? ''} ${intake.property_address_zip ?? ''}`,
            ]
              .filter((part) => part && part.trim())
              .join(', ')
          }
        />
        {/* Only shown when false. A verified address needs no remark; an unverified
            one is a reason to read it back to the customer before it reaches a
            carrier. */}
        {intake.property_addr_verified === false ? (
          <ReadRow label="Address check" value="Typed by hand — not verified" />
        ) : null}
        <ReadRow label="Dwelling" value={intake.dwelling_type} />
        <ReadRow label="Policy form" value={intake.coverage_type} />
      </div>
      <div>
        <ReadRow label="Year built" value={intake.year_built} />
        <ReadRow label="Square footage" value={intake.square_footage} />
        <ReadRow label="Roof" value={intake.roof_type} />
        <ReadRow label="Roof age" value={intake.roof_age === null ? null : `${intake.roof_age} yrs`} />
        <ReadRow label="Last roof update" value={intake.last_roof_update} />
      </div>
    </div>
  );
}

/** Cargo, the way an underwriter needs to read it. */
function CargoBody({ intake }: { intake: LinkedIntake }) {
  const cargo = cargoProfile(intake);
  if (!cargo) return null;

  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
          <p className={ui.statLabel}>Primary category</p>
          <p className="mt-0.5 text-base font-black text-slate-950">
            {cargo.primaryCategory ?? 'Not recorded'}
          </p>
          {cargo.primaryIsLegacy ? (
            <p className="mt-1 text-xs font-bold text-amber-700">
              From the old free-text field. Choose a structured category so a carrier can rate it.
            </p>
          ) : null}
          {cargo.description ? (
            <p className="mt-2 text-sm font-semibold text-slate-700">{cargo.description}</p>
          ) : null}
        </div>
        <div className="grid grid-cols-2 gap-2.5">
          <div className="rounded-2xl border border-slate-200 px-4 py-3">
            <p className={ui.statLabel}>Typical per load</p>
            <p className="mt-0.5 text-lg font-black text-slate-950">
              {formatMoney(cargo.typicalLoadValue)}
            </p>
          </div>
          <div className="rounded-2xl border border-slate-200 px-4 py-3">
            <p className={ui.statLabel}>Maximum per load</p>
            <p
              className={`mt-0.5 text-lg font-black ${
                cargo.maximumLoadValue === null ? 'text-rose-600' : 'text-slate-950'
              }`}
            >
              {cargo.maximumLoadValue === null ? 'Not recorded' : formatMoney(cargo.maximumLoadValue)}
            </p>
          </div>
          <div className="rounded-2xl border border-slate-200 px-4 py-3">
            <p className={ui.statLabel}>Requested limit</p>
            <p className="mt-0.5 text-lg font-black text-slate-950">
              {formatMoney(cargo.requestedLimit)}
            </p>
          </div>
          <div className="rounded-2xl border border-slate-200 px-4 py-3">
            <p className={ui.statLabel}>Deductible</p>
            <p className="mt-0.5 text-lg font-black text-slate-950">
              {formatMoney(cargo.deductible)}
            </p>
          </div>
        </div>
      </div>

      {/* Set by the intake when a high-value category is selected. It routes the quote to
          a specialty review, so it belongs above the detail rather than buried in it. */}
      {intake.high_value_cargo_flag ? (
        <div className="flex items-start gap-2.5 rounded-2xl border border-violet-200 bg-violet-50 px-4 py-3">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-violet-600" />
          <p className="text-sm font-bold text-violet-900">
            High-value cargo — flagged for specialty review.
          </p>
        </div>
      ) : null}

      {/* The limit against the biggest load. The one arithmetic check that stops a
          quote being marketed underinsured. */}
      {cargo.requestedLimit !== null &&
      cargo.maximumLoadValue !== null &&
      cargo.maximumLoadValue > cargo.requestedLimit ? (
        <div className="flex items-start gap-2.5 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
          <p className="text-sm font-bold text-amber-900">
            The highest load recorded ({formatMoney(cargo.maximumLoadValue)}) is above the requested
            cargo limit ({formatMoney(cargo.requestedLimit)}). Confirm the limit before marketing.
          </p>
        </div>
      ) : null}

      <div>
        <p className={ui.statLabel}>Typical commodities</p>
        {cargo.commodities.length === 0 ? (
          <p className="mt-1.5 text-sm font-semibold text-slate-500">
            No commodity breakdown recorded. The mix is captured on the Customer Service intake form,
            which is where to add it.
          </p>
        ) : (
          <ul className="mt-2 space-y-1.5">
            {cargo.commodities.map((commodity) => (
              <li
                key={commodity.label}
                className="flex flex-wrap items-baseline justify-between gap-2 rounded-xl border border-slate-200 px-3.5 py-2"
              >
                <span className="text-sm font-bold text-slate-800">
                  {commodity.label}
                  {commodity.isPrimary ? (
                    <span className="ml-2 text-xs font-black text-[#223f7a]">primary</span>
                  ) : null}
                </span>
                <span className="text-xs font-bold text-slate-500">
                  {[
                    commodity.frequency,
                    commodity.percentHauled === null ? null : `${commodity.percentHauled}%`,
                    commodity.averageValue === null
                      ? null
                      : `avg ${formatMoney(commodity.averageValue)}`,
                    commodity.maximumValue === null
                      ? null
                      : `max ${formatMoney(commodity.maximumValue)}`,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <p className={ui.statLabel}>Does haul</p>
          {cargo.excluded.length === 0 ? (
            <p className="mt-1.5 text-sm font-semibold text-slate-500">
              None of the restricted commodities.
            </p>
          ) : (
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {cargo.excluded.map((item) => (
                <span
                  key={item}
                  className="rounded-lg border border-rose-200 bg-rose-50 px-2.5 py-1 text-xs font-bold text-rose-700"
                >
                  {item}
                </span>
              ))}
            </div>
          )}
        </div>
        <div>
          <p className={ui.statLabel}>Does not haul</p>
          {cargo.notHauled.length === 0 ? (
            <p className="mt-1.5 text-sm font-semibold text-slate-500">Not answered.</p>
          ) : (
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {cargo.notHauled.map((item) => (
                <span
                  key={item}
                  className="rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-xs font-bold text-slate-500"
                >
                  {item}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>

      {cargo.handling.length > 0 ? (
        <div>
          <p className={ui.statLabel}>Handling</p>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {cargo.handling.map((entry) => (
              <span
                key={entry.label}
                className="rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-xs font-bold text-slate-600"
              >
                {entry.label}: {entry.value}
              </span>
            ))}
          </div>
          {yesNoUnsure(intake.hazmat) && intake.hazmat_detail ? (
            <p className="mt-2 text-sm font-semibold text-slate-600">
              Hazmat detail: {intake.hazmat_detail}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function CoverageBody({
  detail,
  intake,
}: {
  detail: OpportunityDetail;
  intake: LinkedIntake;
}) {
  const coverage = requestedCoverage(detail.opportunity.line_of_business, intake);

  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      {coverage.map((line) => (
        <div
          key={line.key}
          className={`rounded-2xl border px-4 py-3 ${
            line.value === null && line.isCore
              ? 'border-rose-200 bg-rose-50/60'
              : 'border-slate-200 bg-white'
          }`}
        >
          <p className={ui.statLabel}>{line.label}</p>
          <p
            className={`mt-0.5 text-lg font-black ${
              line.value === null ? 'text-rose-600' : 'text-slate-950'
            }`}
          >
            {line.value ?? 'Not recorded'}
          </p>
          {line.note ? (
            <p className="mt-0.5 text-xs font-bold text-slate-400">{line.note}</p>
          ) : null}
        </div>
      ))}
    </div>
  );
}

function PriorInsuranceBody({ intake }: { intake: LinkedIntake }) {
  return (
    <div className="grid gap-x-8 sm:grid-cols-2">
      <div>
        <ReadRow
          label="Prior insurance"
          value={intake.prior_insurance === null ? null : intake.prior_insurance ? 'Yes' : 'No'}
        />
        <ReadRow label="Current carrier" value={intake.current_carrier} />
        <ReadRow label="Policy number" value={intake.current_policy_number} />
        <ReadRow label="Current premium" value={formatMoney(intake.current_premium)} />
      </div>
      <div>
        <ReadRow label="Expires" value={intake.current_expiration} />
        <ReadRow label="Months continuous" value={intake.months_continuous_coverage} />
        <ReadRow
          label="Lapse"
          value={intake.prior_lapse === null ? null : intake.prior_lapse ? 'Yes' : 'No'}
        />
        <ReadRow label="Lapse explanation" value={intake.prior_lapse_explanation} />
      </div>
    </div>
  );
}

function LossHistoryBody({
  intake,
  isTrucking,
}: {
  intake: LinkedIntake;
  isTrucking: boolean;
}) {
  if (!isTrucking) {
    return (
      <div>
        <ReadRow
          label="Prior claims"
          value={intake.prior_claims === null ? null : intake.prior_claims ? 'Yes' : 'No'}
        />
        <ReadRow label="Claims detail" value={intake.prior_claims_detail} />
      </div>
    );
  }

  const rows: { label: string; answer: boolean | null; detail: string | null }[] = [
    {
      label: 'Losses in the last three years',
      answer: intake.uw_losses_3yr,
      detail: intake.uw_losses_3yr_detail,
    },
    {
      label: 'Major auto liability loss',
      answer: intake.uw_major_al_loss,
      detail: intake.uw_major_al_loss_detail,
    },
    {
      label: 'Cancelled or non-renewed',
      answer: intake.uw_cancelled_nonrenewed,
      detail: intake.uw_cancelled_nonrenewed_detail,
    },
    {
      label: 'Coverage lapse',
      answer: intake.uw_coverage_lapse,
      detail: intake.uw_coverage_lapse_detail,
    },
    {
      label: 'Uses owner-operators',
      answer: intake.uw_owner_operators,
      detail: intake.uw_owner_operators_detail,
    },
  ];

  return (
    <ul className="space-y-2">
      {rows.map((row) => (
        <li
          key={row.label}
          className="flex flex-wrap items-start justify-between gap-2 rounded-2xl border border-slate-200 px-4 py-3"
        >
          <div className="min-w-0">
            <p className="text-sm font-bold text-slate-800">{row.label}</p>
            {row.detail ? (
              <p className="mt-0.5 text-sm font-semibold text-slate-600">{row.detail}</p>
            ) : null}
          </div>
          <Badge
            tone={row.answer === null ? 'neutral' : row.answer ? 'danger' : 'success'}
          >
            {row.answer === null ? 'Not answered' : row.answer ? 'Yes' : 'No'}
          </Badge>
        </li>
      ))}
    </ul>
  );
}

function DriversBody({
  intake,
  canEdit,
  onEdit,
}: {
  intake: LinkedIntake;
  canEdit: boolean;
  onEdit: (index: number | null) => void;
}) {
  return (
    <div>
      {intake.drivers.length === 0 ? (
        <p className={ui.empty}>No drivers listed.</p>
      ) : (
        <div className="space-y-2">
          {intake.drivers.map((driver, index) => (
            <div
              key={driver.id ?? driver.position}
              className="flex flex-wrap items-start justify-between gap-3 rounded-2xl border border-slate-200 px-4 py-3"
            >
              <div className="min-w-0">
                <p className="text-sm font-black text-slate-900">
                  {`${driver.first_name} ${driver.last_name}`.trim() || `Driver ${driver.position}`}
                  {driver.cdl ? (
                    <span className="ml-2 text-xs font-black text-[#223f7a]">CDL</span>
                  ) : null}
                </p>
                <p className="mt-0.5 text-xs font-bold text-slate-400">
                  {[
                    driver.dob ? `DOB ${driver.dob}` : null,
                    driver.license_number
                      ? `${driver.license_state ?? ''} ${driver.license_number}`.trim()
                      : 'no licence number',
                    driver.years_licensed === null ? null : `${driver.years_licensed} yrs licensed`,
                    driver.cdl
                      ? driver.cdl_years_experience === null
                        ? 'commercial experience not recorded'
                        : `${driver.cdl_years_experience} yrs commercial`
                      : null,
                    driver.owner_operator ? 'owner-operator' : null,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </p>
                {driver.accidents_detail || driver.violations_detail ? (
                  <p className="mt-1 text-sm font-semibold text-slate-600">
                    {[driver.accidents_detail, driver.violations_detail].filter(Boolean).join(' · ')}
                  </p>
                ) : null}
              </div>
              {canEdit ? (
                <button type="button" className={ui.btnSecondary} onClick={() => onEdit(index)}>
                  <Pencil className="h-3.5 w-3.5" />
                  Edit
                </button>
              ) : null}
            </div>
          ))}
        </div>
      )}
      {canEdit ? (
        <button type="button" className={`${ui.btnSecondary} mt-3`} onClick={() => onEdit(null)}>
          <Plus className="h-4 w-4" />
          Add a driver
        </button>
      ) : null}
    </div>
  );
}

function VehiclesBody({
  intake,
  isTrucking,
  canEdit,
  onEdit,
}: {
  intake: LinkedIntake;
  isTrucking: boolean;
  canEdit: boolean;
  onEdit: (index: number | null) => void;
}) {
  return (
    <div className="space-y-4">
      {intake.vehicles.length === 0 ? (
        <p className={ui.empty}>No units listed.</p>
      ) : (
        <div className="space-y-2">
          {intake.vehicles.map((vehicle, index) => (
            <div
              key={vehicle.id ?? vehicle.position}
              className="flex flex-wrap items-start justify-between gap-3 rounded-2xl border border-slate-200 px-4 py-3"
            >
              <div className="min-w-0">
                <p className="flex items-center gap-1.5 text-sm font-black text-slate-900">
                  {isTrucking ? <Truck className="h-4 w-4 text-slate-400" /> : null}
                  {[vehicle.year, vehicle.make, vehicle.model].filter(Boolean).join(' ') ||
                    `Unit ${vehicle.position}`}
                </p>
                <p className="mt-0.5 text-xs font-bold text-slate-400">
                  {[
                    vehicle.vin ?? (vehicle.vin_pending ? 'VIN pending' : 'no VIN'),
                    isTrucking && vehicle.truck_type ? titleCase(vehicle.truck_type) : null,
                    vehicle.ownership ? titleCase(vehicle.ownership) : null,
                    isTrucking
                      ? vehicle.physical_damage_value === null
                        ? 'no stated value'
                        : `${formatMoney(vehicle.physical_damage_value)} stated`
                      : null,
                    isTrucking && vehicle.physical_damage_deductible !== null
                      ? `${formatMoney(vehicle.physical_damage_deductible)} deductible`
                      : null,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </p>
              </div>
              {canEdit ? (
                <button type="button" className={ui.btnSecondary} onClick={() => onEdit(index)}>
                  <Pencil className="h-3.5 w-3.5" />
                  Edit
                </button>
              ) : null}
            </div>
          ))}
        </div>
      )}
      {canEdit ? (
        <button type="button" className={ui.btnSecondary} onClick={() => onEdit(null)}>
          <Plus className="h-4 w-4" />
          Add a unit
        </button>
      ) : null}

      {/* Trailers rate separately from power units. Read-only here: they are captured
          on the intake form and nothing in the quoting workflow edits them. */}
      {isTrucking && intake.trailers.length > 0 ? (
        <div>
          <p className={ui.statLabel}>Trailers ({intake.trailers.length})</p>
          <div className="mt-2 space-y-1.5">
            {intake.trailers.map((trailer) => (
              <p
                key={trailer.id ?? trailer.position}
                className="rounded-xl border border-slate-200 px-3.5 py-2 text-xs font-bold text-slate-600"
              >
                {[trailer.year, trailer.make, trailer.trailer_type ? titleCase(trailer.trailer_type) : null]
                  .filter(Boolean)
                  .join(' ')}
                {trailer.vin ? ` · ${trailer.vin}` : ''}
                {trailer.actual_cash_value === null
                  ? ''
                  : ` · ${formatMoney(trailer.actual_cash_value)}`}
                {trailer.ownership ? ` · ${titleCase(trailer.ownership)}` : ''}
              </p>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
