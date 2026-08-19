/**
 * Trucking Quote Readiness (v1.19.2).
 *
 * Replaces the flat field-completion percentage for trucking. A plain field
 * count told Customer Service nothing useful: a form could read 90% complete
 * while still missing the Auto Liability limit, which makes it unquotable.
 *
 * This scores what a carrier actually needs, weighted, and names what is
 * missing. Nothing here blocks a save — readiness is guidance, and Save Draft
 * stays available at any score.
 */

import type { CsIntakeDriver, CsIntakeSubmission, CsIntakeTrailer, CsIntakeVehicle } from './api';

/** Commercial `usage` keys accepted on a trucking vehicle. Mirrors IntakeForm. */
const TRUCK_USAGE_KEYS = [
  'long_haul',
  'regional',
  'local',
  'delivery',
  'construction',
  'dump',
  'hotshot',
  'other',
];

export interface ReadinessItem {
  /** What is missing, phrased so the agent knows what to ask the customer. */
  label: string;
  /** Which card of the form to look in. */
  section: string;
}

export interface TruckingReadiness {
  /** 0-100, weighted by what carriers actually need. */
  score: number;
  /** Carrier-critical gaps. A submission without these will bounce back. */
  missingEssentials: ReadinessItem[];
  /**
   * Softer gaps and inconsistencies. Worth fixing, but never a reason to hold
   * a new-business submission.
   */
  attentionItems: ReadinessItem[];
}

interface ReadinessCommodity {
  category: string;
  percent_hauled?: number | null;
  average_value?: number | null;
  maximum_value?: number | null;
}

export interface ReadinessInput {
  submission: Partial<CsIntakeSubmission>;
  drivers: CsIntakeDriver[];
  vehicles: CsIntakeVehicle[];
  trailers: CsIntakeTrailer[];
  commodities: ReadinessCommodity[];
}

interface Check {
  weight: number;
  satisfied: boolean;
  label: string;
  section: string;
  /** Essential checks are carrier-critical; the rest are attention items. */
  essential: boolean;
}

const filled = (value: unknown): boolean =>
  value !== null && value !== undefined && String(value).trim() !== '';

/**
 * Weights are deliberately lopsided. Underwriting answers and the requested
 * limits move the number far more than optional CRM detail, because those are
 * what decide whether the risk can be priced at all.
 */
export function computeTruckingReadiness({
  submission,
  drivers,
  vehicles,
  trailers,
  commodities,
}: ReadinessInput): TruckingReadiness {
  const checks: Check[] = [];

  const add = (
    weight: number,
    satisfied: boolean,
    label: string,
    section: string,
    essential = true,
  ) => {
    checks.push({ weight, satisfied, label, section, essential });
  };

  // ── Motor carrier identity (10) ──────────────────────────────────────────
  add(5, filled(submission.business_name), 'Business name', 'Motor Carrier Details');
  add(
    5,
    filled(submission.dot_number) || submission.dot_not_applicable === true,
    'DOT number (or marked not applicable)',
    'Motor Carrier Details',
  );

  // ── Operations (15) ──────────────────────────────────────────────────────
  add(
    6,
    (submission.operation_types?.length ?? 0) > 0,
    'Type of operation',
    'Motor Carrier Details',
  );
  add(
    5,
    filled(submission.radius_band) || filled(submission.operating_radius_miles),
    'Operating radius',
    'Motor Carrier Details',
  );
  add(2, submission.interstate !== null && submission.interstate !== undefined, 'Interstate or intrastate', 'Motor Carrier Details');
  add(2, submission.for_hire !== null && submission.for_hire !== undefined, 'For hire or private carrier', 'Motor Carrier Details');

  // ── Auto Liability (15) ──────────────────────────────────────────────────
  const autoLiabilityAnswered =
    submission.auto_liability_limit === 'other'
      ? filled(submission.auto_liability_limit_other)
      : filled(submission.auto_liability_limit);
  add(15, autoLiabilityAnswered, 'Desired Auto Liability limit', 'Requested Coverages');

  // ── Motor Truck Cargo (15) ───────────────────────────────────────────────
  const cargoAnswered =
    submission.cargo_coverage_desired !== null && submission.cargo_coverage_desired !== undefined;
  add(5, cargoAnswered, 'Desired Cargo limit (or No Cargo)', 'Requested Coverages');

  const cargoWanted = submission.cargo_coverage_desired === true;
  if (cargoWanted) {
    add(4, filled(submission.requested_cargo_limit), 'Cargo limit amount', 'Requested Coverages');
    add(3, commodities.length > 0, 'What commodities are hauled', 'Cargo / Commodities');
    add(
      3,
      filled(submission.max_load_value),
      'Maximum value of any one load',
      'Cargo / Commodities',
    );

    const percentTotal = commodities.reduce((total, row) => total + (row.percent_hauled ?? 0), 0);
    const anyPercent = commodities.some((row) => (row.percent_hauled ?? 0) > 0);
    if (anyPercent && (percentTotal < 98 || percentTotal > 102)) {
      add(
        0,
        false,
        `Commodity percentages total ${Math.round(percentTotal)}%, not about 100%`,
        'Cargo / Commodities',
        false,
      );
    }
  } else {
    // An explicit "No Cargo" leaves nothing further to ask, so the remaining
    // cargo weight is satisfied. An *unanswered* cargo question must not earn
    // it — that would inflate the score on an empty form.
    add(10, submission.cargo_coverage_desired === false, 'Cargo detail', 'Cargo / Commodities');
  }

  // ── Physical Damage (10) ─────────────────────────────────────────────────
  const pdAnswered =
    submission.physical_damage_needed !== null && submission.physical_damage_needed !== undefined;
  add(4, pdAnswered, 'Physical Damage needed or not', 'Requested Coverages');

  if (submission.physical_damage_needed === true) {
    add(
      4,
      vehicles.length > 0 && vehicles.every((vehicle) => filled(vehicle.physical_damage_value)),
      'Actual cash value on every truck',
      'Vehicles',
    );
    add(
      2,
      filled(submission.physical_damage_deductible_requested),
      'Physical Damage deductible',
      'Requested Coverages',
      false,
    );
  } else {
    // Same reasoning as cargo: only an explicit No earns the remaining weight.
    add(
      6,
      submission.physical_damage_needed === false,
      'Physical Damage detail',
      'Requested Coverages',
    );
  }

  // ── Drivers (15) ─────────────────────────────────────────────────────────
  const namedDrivers = drivers.filter(
    (driver, index) => index === 0 || filled(driver.first_name) || filled(driver.last_name),
  );
  add(5, namedDrivers.length > 0, 'At least one driver', 'People / drivers');
  add(
    5,
    namedDrivers.length > 0 &&
      namedDrivers.every((driver) => filled(driver.license_number) && filled(driver.license_state)),
    'License number and state for every driver',
    'People / drivers',
  );

  const cdlDrivers = namedDrivers.filter((driver) => driver.cdl);
  add(
    5,
    cdlDrivers.length === 0 || cdlDrivers.every((driver) => filled(driver.cdl_years_experience)),
    'Years of CDL experience for every CDL driver',
    'People / drivers',
  );

  // ── Vehicles (10) ────────────────────────────────────────────────────────
  add(
    6,
    vehicles.length > 0 &&
      vehicles.every(
        (vehicle) =>
          filled(vehicle.year) &&
          filled(vehicle.make) &&
          filled(vehicle.model) &&
          (filled(vehicle.vin) || vehicle.vin_pending),
      ),
    'Year, make, model and VIN for every truck',
    'Vehicles',
  );
  add(
    2,
    vehicles.length > 0 && vehicles.every((vehicle) => filled(vehicle.truck_type)),
    'Truck type for every unit',
    'Vehicles',
  );
  add(
    2,
    vehicles.length > 0 &&
      vehicles.every((vehicle) => TRUCK_USAGE_KEYS.includes(vehicle.usage || '')),
    'How each truck is used',
    'Vehicles',
    false,
  );

  // ── Underwriting (10) ────────────────────────────────────────────────────
  const uwQuestions: { answered: boolean; explained: boolean; label: string }[] = [
    {
      answered: submission.uw_coverage_lapse !== null && submission.uw_coverage_lapse !== undefined,
      explained: submission.uw_coverage_lapse !== true || filled(submission.uw_coverage_lapse_detail),
      label: 'coverage lapse',
    },
    {
      answered:
        submission.uw_cancelled_nonrenewed !== null &&
        submission.uw_cancelled_nonrenewed !== undefined,
      explained:
        submission.uw_cancelled_nonrenewed !== true ||
        filled(submission.uw_cancelled_nonrenewed_detail),
      label: 'cancellation or non-renewal',
    },
    {
      answered: submission.uw_losses_3yr !== null && submission.uw_losses_3yr !== undefined,
      explained: submission.uw_losses_3yr !== true || filled(submission.uw_losses_3yr_detail),
      label: 'claims or losses',
    },
    {
      answered: submission.uw_major_al_loss !== null && submission.uw_major_al_loss !== undefined,
      explained: submission.uw_major_al_loss !== true || filled(submission.uw_major_al_loss_detail),
      label: 'major Auto Liability loss',
    },
    {
      answered: filled(submission.hazmat),
      explained:
        (submission.hazmat !== 'yes' && submission.hazmat !== 'unsure') ||
        filled(submission.hazmat_detail),
      label: 'hazardous materials',
    },
    {
      answered:
        submission.uw_owner_operators !== null && submission.uw_owner_operators !== undefined,
      explained:
        submission.uw_owner_operators !== true || filled(submission.uw_owner_operators_detail),
      label: 'owner / operators',
    },
  ];

  const unanswered = uwQuestions.filter((question) => !question.answered);
  add(
    10,
    unanswered.length === 0,
    unanswered.length
      ? `${unanswered.length} underwriting question${unanswered.length === 1 ? '' : 's'} unanswered`
      : 'Underwriting questions',
    'Underwriting / Eligibility',
  );

  uwQuestions
    .filter((question) => question.answered && !question.explained)
    .forEach((question) => {
      add(0, false, `Yes on ${question.label} needs an explanation`, 'Underwriting / Eligibility', false);
    });

  // ── Trailers (attention only) ────────────────────────────────────────────
  if (submission.owns_or_leases_trailers === true) {
    if (!trailers.length) {
      add(0, false, 'Trailers answered Yes but none listed', 'Trailers', false);
    } else if (trailers.some((trailer) => !filled(trailer.actual_cash_value))) {
      add(0, false, 'Actual cash value missing on a trailer', 'Trailers', false);
    }
  }

  // ── Contact detail (5) ───────────────────────────────────────────────────
  add(3, filled(submission.insured_phone_primary), 'Primary phone', 'Named Insured');
  add(2, filled(submission.insured_email), 'Email address', 'Named Insured');

  const totalWeight = checks.reduce((total, check) => total + check.weight, 0);
  const earned = checks.reduce((total, check) => total + (check.satisfied ? check.weight : 0), 0);

  return {
    score: totalWeight === 0 ? 0 : Math.round((earned / totalWeight) * 100),
    missingEssentials: checks
      .filter((check) => !check.satisfied && check.essential)
      .map(({ label, section }) => ({ label, section })),
    attentionItems: checks
      .filter((check) => !check.satisfied && !check.essential)
      .map(({ label, section }) => ({ label, section })),
  };
}
