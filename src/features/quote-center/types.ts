/**
 * Quote Center types.
 *
 * These mirror the return shapes of the `quote_center_*` RPCs in
 * supabase/migrations/v1.15.2-quote-center-search.sql. Field names are kept in
 * the database's snake_case so there is no silent translation layer between what
 * the SQL returns and what the screen reads — a rename here that the SQL does not
 * know about would fail loudly at the type level rather than quietly produce
 * undefined.
 */

/**
 * The five top-level buckets an employee sees, in lifecycle order.
 *
 * These are a presentation vocabulary, not a new state machine. Every underlying
 * status still exists and is still authoritative; `stage` is how the database
 * groups them so an agent never has to know what `pending_pricing_quotes` is.
 */
export type JourneyStage = 'intake' | 'working' | 'price_sent' | 'closed';

/** Includes the "no filter" option that only the UI needs. */
export type StageFilter = 'all' | JourneyStage;

/** One row of Quote Center search results: exactly what a result card shows. */
export interface JourneySearchRow {
  /** Stable key for the journey. `intake:<uuid>` or `quote:<uuid>`. */
  journey_key: string;
  intake_id: string | null;
  /**
   * The stable quote identity. Present whenever this journey ever produced a
   * quote — including when the quote row was later deleted, which is why
   * {@link has_quote} and not this field decides whether quote actions apply.
   */
  work_item_id: string | null;
  customer_name: string;
  business_name: string | null;
  phone_primary: string | null;
  email: string | null;
  addr_city: string | null;
  addr_state: string | null;
  line_of_business: string | null;
  work_type: string | null;
  /** Dealer name, Walk-In, RingCentral, or however the work arrived. */
  source_label: string | null;
  dealer_name: string | null;
  salesperson_name: string | null;
  started_by_name: string | null;
  completed_by_name: string | null;
  assigned_agent_name: string | null;
  stage: JourneyStage;
  /** The chip text, e.g. "Draft — Needs Information", "Price Sent", "Sold". */
  stage_label: string;
  intake_status: string | null;
  decision: string | null;
  started_at: string | null;
  submitted_at: string | null;
  price_sent_at: string | null;
  finalized_at: string | null;
  last_activity_at: string | null;
  has_intake: boolean;
  /** True only when a live quote row exists in one of the three stage tables. */
  has_quote: boolean;
  is_voided: boolean;
  /** Another journey shares this phone number. A prompt to look, not a verdict. */
  possible_duplicate: boolean;
  /** Total matches for the query, so the page can show "showing N of M". */
  total_count: number;
}

/**
 * The Specialty Quotes overlay, appended to `quote_center_journeys` by v1.16.5.
 *
 * Present on the detail row rather than on the search row: the search's
 * `stage`/`stage_label` already carry the specialty status, so a card needs nothing
 * extra, and the drawer is where the specialty panel is offered.
 */
export interface SpecialtyOverlay {
  /** Non-null when this customer's work is with a specialty quoting team. */
  specialty_opportunity_id: string | null;
  specialty_reference: string | null;
  /** How many shared information items the specialty team is still waiting on. */
  specialty_information_needed: number;
}

/**
 * The full journey record behind the detail drawer.
 *
 * A superset of {@link JourneySearchRow}: search returns only card fields, and
 * the extra detail is fetched when a journey is actually opened.
 */
export interface JourneyDetail
  extends Omit<JourneySearchRow, 'total_count' | 'possible_duplicate'>,
    SpecialtyOverlay {
  insured_first_name: string | null;
  insured_last_name: string | null;
  insured_dob: string | null;
  phone_alt: string | null;
  phone_digits: string;
  phone_alt_digits: string;
  addr_street: string | null;
  addr_unit: string | null;
  addr_zip: string | null;
  renters_property_address: string | null;
  renters_city: string | null;
  renters_state: string | null;
  quote_kind: string | null;
  dot_number: string | null;
  is_walk_in: boolean;
  intake_channel: string | null;
  source_type: string | null;
  dealer_id: string | null;
  salesperson_id: string | null;
  assignment_method: string | null;
  started_by_id: string | null;
  completed_by_id: string | null;
  last_edited_by_id: string | null;
  last_edited_by_name: string | null;
  assigned_profile_id: string | null;
  not_sold_reason: string | null;
  claimed_at: string | null;
  converted_at: string | null;
  quote_created_at: string | null;
  source_commercial_quote_id: string | null;
  /** The version to echo back when saving, so a stale edit is refused. */
  intake_version: number | null;
  renters_addr_verified: boolean;
  addr_verified: boolean;
}

/** Where a timeline entry came from. Drives the icon and colour. */
export type TimelineOrigin = 'intake' | 'quote' | 'note';

/** One entry in the merged journey timeline. */
export interface TimelineEntry {
  occurred_at: string;
  origin: TimelineOrigin;
  event_type: string;
  actor_name: string;
  note: string | null;
  detail: Record<string, unknown> | null;
}

/**
 * The customer information behind a journey.
 *
 * Both halves are optional because which one exists depends on where the quote came
 * from. A Customer Service intake fills `intake` with every answer on the form; a
 * WhatsApp, RingCentral or manually created quote fills `quote` with the dealer, the
 * salesperson, the customer name and the agent's note. A converted intake has both.
 *
 * Loosely typed on purpose: `intake` is the whole `cs_intake_submissions` row plus
 * its children, and the fields present differ by line of business. The renderer
 * reads what it needs and ignores the rest, which is preferable to a ~120-field
 * interface that would drift from the table on the next migration.
 */
export interface JourneyRecord {
  intake: (Record<string, unknown> & {
    line_of_business?: string | null;
    drivers?: Record<string, unknown>[];
    vehicles?: Record<string, unknown>[];
    owners?: Record<string, unknown>[];
  }) | null;
  quote: (Record<string, unknown> & {
    customer_name?: string | null;
    dealer_name?: string | null;
    dealer_notes?: string | null;
    salesperson_name?: string | null;
    received_through?: string | null;
    assignment_method?: string | null;
    work_type?: string | null;
    note?: string | null;
    change_type?: string | null;
    assigned_agent_name?: string | null;
    original_owner_name?: string | null;
  }) | null;
}

/** A possible existing record surfaced while a new intake is being started. */
export interface DuplicateCandidate {
  journey_key: string;
  intake_id: string | null;
  work_item_id: string | null;
  customer_name: string;
  business_name: string | null;
  phone_primary: string | null;
  email: string | null;
  addr_city: string | null;
  addr_state: string | null;
  line_of_business: string | null;
  source_label: string | null;
  assigned_agent_name: string | null;
  started_by_name: string | null;
  stage: JourneyStage;
  stage_label: string;
  started_at: string | null;
  last_activity_at: string | null;
  /** Why this was surfaced, e.g. "Same phone number". Shown to the employee. */
  match_reason: string;
}

/** The identity signals a duplicate check runs on. Name alone is never enough. */
export interface DuplicateCheckInput {
  excludeIntakeId?: string | null;
  phone?: string | null;
  email?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  businessName?: string | null;
  dob?: string | null;
}

export interface StageCount {
  stage: JourneyStage;
  journey_count: number;
}
