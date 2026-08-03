// The drawer's two manual send actions: `Send Reminder Now` and `Retry Failed Communication`.
//
// `POST /api/cancellations/send` is a six-line handler over `runManualSend` below, the same shape
// `POST /api/cancellations/scheduler` has over `runScheduler` in `./run`. Every seam the work
// function needs — the Supabase client, both providers, the clock, the business date, the session
// reader, the email reply-to — arrives as a parameter, so task 15.2 drives both actions and every
// refusal without a running Next server.
//
// Requirement 17 criteria 5, 6, 11, and 12 are the contract, with Requirements 21, 22, and 26.6
// constraining who may act and what a suppression and the kill switch do:
// - 17.5   `Send Reminder Now` sends the message rendered for the **current Touchpoint** — the
//          Touchpoint whose scheduled date is the latest one not later than the current business
//          date, and the 15-day Touchpoint where none has arrived — to every Contact_Recipient
//          whose validation status is valid, whose authorization status permits contact, and whose
//          channel suppression is not set, stores one Communication_Record per Idempotency_Key, and
//          reports the recipients sent, skipped, and failed
// - 17.6   `Retry Failed Communication` is Manager_Role only, targets only the Contact_Recipient
//          rows whose Communication_Record for the current Touchpoint and channel holds a failed
//          delivery result, updates that existing row with the new send time, provider message
//          identifier, and delivery result **instead of storing a second row**, leaves the stored
//          template version, rendered subject, and rendered body unchanged, and adds one retry
//          entry per Contact_Recipient and channel to the chronological audit timeline
// - 17.11  an Idempotency_Key whose stored row is **not** failed is not sent to, stores no
//          additional row, and is reported in the skipped count as already sent
// - 17.12  zero eligible Contact_Recipient rows on the target channel sends zero messages, stores
//          zero rows, leaves Case_Status unchanged, and returns an error stating that valid
//          authorized contact information is required for that channel
// - 21.3 / 21.4  a stored suppression excludes that value from both actions with zero
//          Communication_Record rows created — the same `eligibleContacts` filter the scheduler
//          uses, so there is one implementation of the exclusion and not two
// - 22.2 / 22.6 / 22.12  Agent_Role may use both actions listed in Requirement 17.3 on a record
//          assigned to that profile; a write on a record assigned to anybody else, or to nobody, is
//          answered 403 with every stored value unchanged, and Requirement 17.10 reserves
//          `Retry Failed Communication` to Manager_Role
// - 26.6   **both actions work while `automatic_sending_enabled` is false.** The settings row is
//          read for its render constants and the kill switch is reported in the summary, never
//          consulted as a gate. That is the whole difference from the batch, which stops on it.
// - 15.9   a stored row and a changed delivery result both recompute Communication_Status, which
//          runs here through `cancellation_recompute_communication_status` after the sends
//
// ---------------------------------------------------------------------------------------------
// FAIL CLOSED, BEFORE ANYTHING EXISTS TO WRITE WITH
// ---------------------------------------------------------------------------------------------
// This is a network-exposed endpoint. `handleManualSendRequest` resolves the session, refuses a
// role outside the workspace, and refuses a `Retry Failed Communication` from anything other than
// `manager` or `super_admin` **before** a Supabase client is constructed, so an unauthorized
// request writes zero rows and makes zero provider calls structurally rather than by promise. The
// case-scope check of Requirements 22.2 and 22.6 needs the case row, so it runs first inside
// `runManualSend`, before any read of contacts, any render, and any provider call. Both gates are
// re-asserted in the work function: it is the seam a test drives directly, and a permission that
// only exists in the HTTP wrapper is a permission a future caller can walk around.
//
// ---------------------------------------------------------------------------------------------
// WHY THE SERVICE-ROLE CLIENT
// ---------------------------------------------------------------------------------------------
// `public.cancellation_retry_communication` is the only update path the Communication_Record
// immutability trigger admits, and it accepts Manager_Role, the service role, and a direct database
// connection — nothing else. Recording a provider outcome is step 3 of every send, so an agent's
// `Send Reminder Now` under their own session client would reserve the row, call the provider, and
// then fail to record: a row reading `Sent`, attempt 1, no provider id. So the handler passes the
// service-role client from `createSchedulerServiceClient()`, exactly as the batch does, and the
// authorization above is what stands in for the row level security that client bypasses.
//
// ---------------------------------------------------------------------------------------------
// ONE MESSAGE PER (CONTACT, CHANNEL) — NO COMBINING
// ---------------------------------------------------------------------------------------------
// Requirement 13's combined message covers several Cancellation_Cases of one matched customer. A
// manual action names one case, so there is nothing to combine: each eligible Contact_Recipient and
// channel is its own message with its own Idempotency_Key. Grouping stays entirely in the batch.
//
// ---------------------------------------------------------------------------------------------
// THE RESEND OF A FAILED ROW, WHICH BOTH ACTIONS SHARE
// ---------------------------------------------------------------------------------------------
// Requirement 17.11 stops `Send Reminder Now` only at a stored row that is *not* failed. A stored
// row that *is* failed may be sent again — and cannot be inserted again, the Idempotency_Key being
// unique — so the correct handling is Requirement 17.6's: submit the **stored** subject and body to
// the provider and write the outcome onto the existing row through `recordProviderOutcome`. Both
// actions therefore share one resend routine, and the stored text is re-sent rather than
// re-rendered, which is what keeps `template_version_id`, `rendered_subject`, and `rendered_body`
// byte-identical. `attempt_count` is carried up from the stored value, because the retry function
// refuses to lower it.
//
// The content gate is not re-run over a stored body. It ran inside `renderMessage` before that row
// existed, and Requirement 17.6 requires the stored text to go out unchanged; re-gating could only
// either block a message the requirement says to send or, worse, tempt a caller into editing the
// body to get past it.
//
// ---------------------------------------------------------------------------------------------
// THE READS AND WRITES, LISTED SO A TEST DOUBLE CAN IMPLEMENT EXACTLY THEM
// ---------------------------------------------------------------------------------------------
// Reads use only `.select(columns)`, `.in(column, values)`, and `.is(column, null)`, awaited
// directly — the same three the `./run` double implements:
//
//   select  cancellation_settings
//   select  cancellation_cases                 .in('id', [caseId])
//   select  cancellation_contacts              .in('case_id', [caseId])
//   select  cancellation_suppressions          .is('cleared_at', null)
//   select  cancellation_communications        .in('case_id', [caseId])
//   select  cancellation_templates
//   select  cancellation_template_versions
//   select  cancellation_prohibited_phrases
//   select  profiles                           .in('id', [assignedTo])
//   insert  cancellation_communications        (inside sendCommunication)
//   insert  cancellation_communication_cases   (inside sendCommunication)
//   rpc     cancellation_retry_communication   (inside sendCommunication and recordProviderOutcome)
//   insert  cancellation_events                retry entries, and a content-gate block entry
//   update  cancellation_cases                 communication_status on a gate block only
//   rpc     cancellation_recompute_communication_status
//
// `cancellation_cases.case_status` is never written from this file. Delivery results never change
// Case_Status (Requirements 15.3, 15.4), and Requirement 17.12 requires it unchanged on the
// zero-eligible-contact refusal, so the guarantee is structural: there is no code path here that
// could write it.

import type { SupabaseClient } from '@supabase/supabase-js';

import { canAccessRenewals, isBroadManagerRole } from '@/lib/permissions';
import type { AppRole } from '@/lib/types';

import { currentBusinessDate, AGENCY_TIME_ZONE } from '../../renewals/derive';
import { MANUAL_FOLLOW_UP_STATUS } from '../domain/escalation';
import {
  currentTouchpoint,
  daysRemaining,
  pendingTouchpointChannelSends,
  type CommunicationRecord,
  type DeliveryResult,
} from '../domain/communication-status';
import {
  eligibleContacts,
  SUPPRESSION_CHANNELS,
  type SuppressionChannel,
  type SuppressionRecord,
} from '../domain/suppression';
import { hasDeletedSuffix } from '../import/fields';
import {
  renderMessage,
  type AssignedEmployee,
  type ProhibitedPhraseRow,
  type RenderChannel,
  type RenderResult,
  type TemplateVersionRow,
  type Touchpoint,
} from '../render/renderMessage';
import {
  createSchedulerServiceClient,
  readSchedulerRole,
  resolveSessionProfile,
  serviceRoleUnconfigured,
  type SchedulerSessionResolver,
} from './authorize';
import {
  joinTemplateTouchpoints,
  resolveEmailConfigured,
  scheduledSendsFor,
  SEND_BLOCKED_EVENT_TYPE,
  type SchedulerCaseRow,
  type SchedulerContactRow,
  type SchedulerProfileRow,
  type SchedulerSettingsRow,
} from './run';
import {
  deliverMessage,
  recordProviderOutcome,
  sendCommunication,
  type SendProviders,
} from './send';

// ---------------------------------------------------------------------------
// The two actions
// ---------------------------------------------------------------------------

/** The two controls of Requirement 17.3 this route performs. */
export type ManualSendAction = 'send_now' | 'retry_failed';

export const MANUAL_SEND_ACTIONS = ['send_now', 'retry_failed'] as const satisfies readonly ManualSendAction[];

/** `Send Reminder Now` (Requirement 17.5). Available to Agent_Role and Manager_Role alike. */
export const SEND_NOW_ACTION: ManualSendAction = 'send_now';

/** `Retry Failed Communication` (Requirements 17.6, 17.10). Manager_Role only. */
export const RETRY_FAILED_ACTION: ManualSendAction = 'retry_failed';

/** `cancellation_events.event_type` for the Requirement 17.6 retry entry. */
export const COMMUNICATION_RETRIED_EVENT_TYPE = 'communication_retried';

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

/** Requirement 17.12: the target channel has no valid, authorized, unsuppressed recipient. */
export const NO_ELIGIBLE_CONTACT_MESSAGE =
  'Valid authorized contact information is required for that channel. Nothing was sent, no '
  + 'communication was recorded, and the case status is unchanged.';

/** Requirement 17.10 and 22.6: `Retry Failed Communication` is reserved to Manager_Role. */
export const RETRY_REQUIRES_MANAGER_MESSAGE =
  'Retry Failed Communication requires a manager. Nothing was sent and nothing was written.';

/** Requirement 22.6: this profile's role does not permit the Policy Follow-up write. */
export const ROLE_NOT_PERMITTED_MESSAGE =
  "This profile's role does not permit that operation. Nothing was sent and nothing was written.";

/** Requirements 22.2, 22.6, 22.12: a write is limited to a record assigned to that profile. */
export const CASE_NOT_ASSIGNED_MESSAGE =
  'This cancellation is not assigned to you, so only a manager may send for it. Nothing was sent '
  + 'and nothing was written.';

/** The requested Cancellation_Case does not exist. */
export const CASE_NOT_FOUND_MESSAGE =
  'That cancellation could not be found. Nothing was sent and nothing was written.';

/** The request body named no case, or named an action outside the two. */
export const INVALID_REQUEST_MESSAGE =
  'The request needs a cancellation case identifier and an action of send_now or retry_failed.';

/** No `cancellation_settings` row, so no compliant message could be rendered. */
export const SETTINGS_ABSENT_MESSAGE =
  'The cancellation settings row is absent, so no compliant message could be rendered. Nothing '
  + 'was sent.';

// ---------------------------------------------------------------------------
// Actor and scope
// ---------------------------------------------------------------------------

/** The signed-in profile performing the action; `actor_id` on every audit entry written. */
export interface ManualSendActor {
  profileId: string;
  role: AppRole;
}

/** True for `manager` and `super_admin`, which hold every Manager_Role permission. */
export function isManagerActor(actor: ManualSendActor): boolean {
  return isBroadManagerRole(actor.role);
}

/**
 * Whether a role may act in the Policy Follow-up workspace at all.
 *
 * `canAccessRenewals` is the workspace gate the Renewals tab already uses and the one
 * `canReadCancellationCase` in `../derive` reads: `agent`, `customer_service`, `sales_supervisor`,
 * `manager`, and `super_admin`. Every other role is answered 403 here (Requirement 22.6).
 */
export function roleMayUseManualSend(role: AppRole): boolean {
  return canAccessRenewals(role);
}

// ---------------------------------------------------------------------------
// The current Touchpoint (Requirement 17.5)
// ---------------------------------------------------------------------------

/**
 * The current Touchpoint of a case: the Touchpoint whose scheduled date is the latest one not later
 * than the business date, and the 15-day Touchpoint where no scheduled date has arrived
 * (Requirement 17.5).
 *
 * A Touchpoint's scheduled date is the cancellation effective date minus its days, so a date not
 * later than the business date means the Touchpoint's days are at least the days remaining, and the
 * latest such date belongs to the fewest such days. 12 days remaining resolves to the 15-day
 * Touchpoint, 6 to the 10-day, 0 and every negative number to the 1-day. An absent or unreadable
 * effective date takes the same fallback as a case whose first Touchpoint has not arrived.
 *
 * `currentTouchpoint` in `../domain/communication-status` is that arithmetic, and it is what the
 * drawer's primary action reads too, so the Touchpoint the button offers and the Touchpoint this
 * route sends are one value computed once.
 */
export function resolveCurrentTouchpoint(
  effectiveDate: string | null | undefined,
  businessDate: string,
): Touchpoint {
  const remaining = daysRemaining(effectiveDate, businessDate);
  return remaining === null ? 15 : currentTouchpoint(remaining);
}

// ---------------------------------------------------------------------------
// Outcome vocabulary
// ---------------------------------------------------------------------------

/** Why one Idempotency_Key sent nothing. */
export type ManualSendSkipReason =
  /** Requirement 17.11: the stored row for the key is not failed, so the Touchpoint was sent. */
  | 'already_sent'
  /** `Retry Failed Communication` only: the key has no stored row, so nothing failed to retry. */
  | 'no_failed_record'
  /** Requirement 23.3: no email credentials, so zero rows are written for the key. */
  | 'email_not_configured'
  /** Requirements 14.9, 14.10: the content gate refused the assembled message. */
  | 'render_blocked'
  /** A row appeared between the read and the reserving insert (`23505`). */
  | 'existing_record'
  /** The stored contact value carried no address to send to. */
  | 'recipient_absent';

/** What happened for one (contact, channel) pair at the current Touchpoint. */
export interface ManualSendKeyOutcome {
  contactId: string;
  channel: SuppressionChannel;
  touchpoint: Touchpoint;
  /** The recipient the message went to, for the drawer's per-recipient report. */
  recipient: string;
  status: 'sent' | 'failed' | 'skipped';
  /** Set only on a skip. */
  reason: ManualSendSkipReason | null;
  communicationId: string | null;
  deliveryResult: DeliveryResult | null;
  providerMessageId: string | null;
  failureReason: string | null;
  attemptCount: number | null;
  /** True where the stored row was updated in place rather than inserted (Requirement 17.6). */
  updatedExistingRow: boolean;
}

/** One thing that went wrong without ending the action (Requirements 13.9, 14.18). */
export interface ManualSendFailure {
  stage: string;
  contactId: string | null;
  channel: SuppressionChannel | null;
  message: string;
  code: string | null;
}

/** What one manual send did (Requirement 17.5's sent, skipped, and failed counts). */
export interface ManualSendSummary {
  action: ManualSendAction;
  caseId: string;
  /** The business date the current Touchpoint was resolved against, as `YYYY-MM-DD`. */
  businessDate: string;
  /** The current Touchpoint of Requirement 17.5. */
  touchpoint: Touchpoint;
  /** The channels the action targeted, in send order. */
  channels: SuppressionChannel[];
  /**
   * The Requirement 26.4 kill switch as stored, reported and never consulted: Requirement 26.6
   * has both actions send while it is false.
   */
  automaticSendingEnabled: boolean;
  emailConfigured: boolean;
  /** Eligible Contact_Recipient rows per channel (Requirement 17.5's conditions). */
  eligibleContacts: Record<SuppressionChannel, number>;
  counts: { sent: number; skipped: number; failed: number };
  /** Requirement 17.11: keys skipped because the current Touchpoint was already sent. */
  alreadySent: number;
  keys: ManualSendKeyOutcome[];
  /** `cancellation_communications` rows inserted. */
  communicationRowsWritten: number;
  /** Stored rows updated in place through `cancellation_retry_communication` (Req 17.6). */
  communicationRowsUpdated: number;
  /** `cancellation_communication_cases` rows written. */
  linkRowsWritten: number;
  /** Requirement 17.6 retry entries appended to the audit timeline. */
  retryEventsWritten: number;
  /** Messages the content gate refused (Requirements 14.9, 14.10). */
  blockedMessages: number;
  /** True where `cancellation_recompute_communication_status` ran (Requirement 15.9). */
  statusRecomputed: boolean;
  failures: ManualSendFailure[];
}

/** Why a manual send was refused outright, with zero rows written. */
export type ManualSendRejectionCode =
  | 'invalid_request'
  | 'forbidden_role'
  | 'forbidden_case_scope'
  | 'case_not_found'
  | 'no_eligible_contact'
  | 'settings_absent'
  | 'read_failed';

export interface ManualSendRejection {
  code: ManualSendRejectionCode;
  message: string;
  /** The HTTP status the handler answers with. */
  status: number;
}

export type ManualSendResult =
  | { ok: true; summary: ManualSendSummary }
  | { ok: false; rejection: ManualSendRejection };

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

export interface ManualSendInput {
  /**
   * The service-role client. `cancellation_retry_communication` admits Manager_Role, the service
   * role, and nothing else, and step 3 of every send goes through it, so a weaker client leaves
   * rows reading `Sent`, attempt 1, no provider id.
   */
  client: SupabaseClient;
  caseId: string;
  action: ManualSendAction;
  actor: ManualSendActor;
  /** The target channels. Absent, both: Requirement 17.5 names every Contact_Recipient. */
  channels?: readonly SuppressionChannel[];
  providers?: SendProviders;
  /** Clock seam. Supplies send times, audit times, and the default business date. */
  now?: () => Date;
  /** Pins the business date. Absent, the calendar date in `timeZone` at `now()`. */
  businessDate?: string;
  /** The agency time zone the business date resolves in. Defaults to `America/New_York`. */
  timeZone?: string;
  /** Backoff seam for the email retry policy, so a test does not wait 20 seconds. */
  sleep?: (ms: number) => Promise<void>;
  /** Waits between consecutive email attempts, each clamped into [5 s, 60 s] (Req 23.8). */
  backoffMs?: readonly number[];
  /** Group-id seam, passed through to `sendCommunication`. */
  newGroupId?: () => string;
  /**
   * The email reply-to (Requirements 23.2, 23.7). Absent, `null` is passed and `src/lib/email.ts`
   * falls back to `CANCELLATION_EMAIL_REPLY_TO`.
   */
  replyTo?: string | null;
  /** Set false to skip the Requirement 15.9 recompute. Default true. */
  recomputeStatus?: boolean;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SETTINGS_TABLE = 'cancellation_settings';
const CASES_TABLE = 'cancellation_cases';
const CONTACTS_TABLE = 'cancellation_contacts';
const SUPPRESSIONS_TABLE = 'cancellation_suppressions';
const COMMUNICATIONS_TABLE = 'cancellation_communications';
const TEMPLATES_TABLE = 'cancellation_templates';
const TEMPLATE_VERSIONS_TABLE = 'cancellation_template_versions';
const PHRASES_TABLE = 'cancellation_prohibited_phrases';
const EVENTS_TABLE = 'cancellation_events';
const PROFILES_TABLE = 'profiles';
const RECOMPUTE_RPC = 'cancellation_recompute_communication_status';

const SETTINGS_COLUMNS =
  'automatic_sending_enabled,office_phone,agency_name,bilingual_separator,holidays';
const CASE_COLUMNS =
  'id,policy_number,cancellation_effective_date,customer_name,customer_match_key,carrier,'
  + 'cancellation_reason,amount_due,case_status,communication_status,next_required_action,'
  + 'assigned_to,producer_label,follow_up_deadline,assistance_requested';
const CONTACT_COLUMNS =
  'id,case_id,channel,normalized_value,validation_status,authorization_status,sms_suppressed,'
  + 'email_suppressed,is_primary,preferred_language,contact_name,segment_index';
const SUPPRESSION_COLUMNS = 'id,channel,normalized_value,cleared_at';
/**
 * Wider than the batch's list: a resend submits the **stored** subject and body and counts attempts
 * up from the stored value, so those three columns are read rather than re-derived (Req 17.6).
 */
const COMMUNICATION_COLUMNS =
  'id,case_id,contact_id,touchpoint,channel,template_version_id,rendered_subject,rendered_body,'
  + 'delivery_result,send_time,failure_reason,attempt_count,combined_group_id';
const TEMPLATE_COLUMNS = 'id,touchpoint';
const TEMPLATE_VERSION_COLUMNS =
  'id,template_id,version,language,subject,body,cancellation_statement,contact_request,fallback_text';
const PHRASE_COLUMNS = 'id,phrase,language,claim_category,is_active';
const PROFILE_COLUMNS = 'id,display_name,role,is_active';

/** The `cancellation_communications` columns a resend reads, on top of `CommunicationRecord`. */
interface StoredCommunicationRow extends CommunicationRecord {
  id: string;
  template_version_id?: string | null;
  rendered_subject?: string | null;
  rendered_body?: string | null;
}

// ---------------------------------------------------------------------------
// The work
// ---------------------------------------------------------------------------

/**
 * One manual send: `Send Reminder Now` or `Retry Failed Communication` for one Cancellation_Case at
 * its current Touchpoint.
 *
 * Order:
 *  1. the role gate — Requirement 17.10 reserves the retry to Manager_Role;
 *  2. the case row, then the case-scope gate of Requirements 22.2, 22.6, and 22.12;
 *  3. the settings row, read for its render constants only: Requirement 26.6 sends while the kill
 *     switch is off, so `automatic_sending_enabled` is reported and never consulted;
 *  4. contacts and active suppressions, reduced to the eligible recipients per channel through the
 *     same `eligibleContacts` the batch uses (Requirements 17.5, 21.3, 21.4); zero across every
 *     target channel is Requirement 17.12's refusal, with zero rows written;
 *  5. per (contact, channel): a stored row that is not failed is skipped as already sent
 *     (Requirement 17.11), a stored failed row is re-sent and updated in place (Requirement 17.6),
 *     and no stored row is reserved, sent, and recorded through `sendCommunication`;
 *  6. one retry entry per updated row, then the Requirement 15.9 status recompute.
 *
 * Never throws for a database or provider outcome: everything is reported as data so one bad
 * recipient cannot lose the rest (Requirements 13.9, 14.18).
 */
export async function runManualSend(input: ManualSendInput): Promise<ManualSendResult> {
  const client = input.client;
  const now = input.now ?? (() => new Date());
  const timeZone = input.timeZone ?? AGENCY_TIME_ZONE;
  const businessDate = input.businessDate ?? currentBusinessDate(now(), timeZone);
  const channels = resolveChannels(input.channels);
  const emailConfigured = resolveEmailConfigured(input.providers);

  // ── 1. Requirement 17.10: the retry is Manager_Role only, and this is asserted here as well as
  //       in the handler because this function is the seam a caller can reach directly.
  if (input.action === RETRY_FAILED_ACTION && !isManagerActor(input.actor)) {
    return reject('forbidden_role', RETRY_REQUIRES_MANAGER_MESSAGE, 403);
  }
  if (!roleMayUseManualSend(input.actor.role)) {
    return reject('forbidden_role', ROLE_NOT_PERMITTED_MESSAGE, 403);
  }

  const summary: ManualSendSummary = {
    action: input.action,
    caseId: input.caseId,
    businessDate,
    touchpoint: 15,
    channels,
    automaticSendingEnabled: true,
    emailConfigured,
    eligibleContacts: { sms: 0, email: 0 },
    counts: { sent: 0, skipped: 0, failed: 0 },
    alreadySent: 0,
    keys: [],
    communicationRowsWritten: 0,
    communicationRowsUpdated: 0,
    linkRowsWritten: 0,
    retryEventsWritten: 0,
    blockedMessages: 0,
    statusRecomputed: false,
    failures: [],
  };

  // ── 2. The case row, and the write scope of Requirements 22.2, 22.6, and 22.12.
  const caseRead = await readRows<SchedulerCaseRow>(
    () => client.from(CASES_TABLE).select(CASE_COLUMNS).in('id', [input.caseId]),
    'read_case',
  );
  if (caseRead.failure !== null) {
    return reject('read_failed', caseRead.failure.message, 503);
  }
  const caseRow = caseRead.rows.find((row) => row.id === input.caseId) ?? caseRead.rows[0];
  if (caseRow === undefined) {
    return reject('case_not_found', CASE_NOT_FOUND_MESSAGE, 404);
  }
  if (!isManagerActor(input.actor) && !isAssignedTo(caseRow, input.actor)) {
    return reject('forbidden_case_scope', CASE_NOT_ASSIGNED_MESSAGE, 403);
  }

  summary.touchpoint = resolveCurrentTouchpoint(caseRow.cancellation_effective_date, businessDate);
  const touchpoint = summary.touchpoint;

  // ── 3. The settings row: render constants, plus the kill switch for the report (Req 26.6).
  const settingsRead = await readRows<SchedulerSettingsRow>(
    () => client.from(SETTINGS_TABLE).select(SETTINGS_COLUMNS),
    'read_settings',
  );
  if (settingsRead.failure !== null) {
    return reject('read_failed', settingsRead.failure.message, 503);
  }
  const settings = settingsRead.rows[0];
  if (settings === undefined) {
    return reject('settings_absent', SETTINGS_ABSENT_MESSAGE, 503);
  }
  summary.automaticSendingEnabled = settings.automatic_sending_enabled !== false;

  // ── 4. The recipients: valid, permitted authorization, channel flag clear, value not suppressed.
  const contactRead = await readRows<SchedulerContactRow>(
    () => client.from(CONTACTS_TABLE).select(CONTACT_COLUMNS).in('case_id', [input.caseId]),
    'read_contacts',
  );
  if (contactRead.failure !== null) summary.failures.push(contactRead.failure);

  const suppressionRead = await readRows<SuppressionRecord>(
    () => client.from(SUPPRESSIONS_TABLE).select(SUPPRESSION_COLUMNS).is('cleared_at', null),
    'read_suppressions',
  );
  if (suppressionRead.failure !== null) summary.failures.push(suppressionRead.failure);

  const contacts = contactRead.rows.filter((row) => typeof row.id === 'string' && row.id.length > 0);
  const activeSuppressions = suppressionRead.rows;
  const eligible: Record<SuppressionChannel, SchedulerContactRow[]> = {
    sms: eligibleContacts(contacts, activeSuppressions, 'sms'),
    email: eligibleContacts(contacts, activeSuppressions, 'email'),
  };
  summary.eligibleContacts = { sms: eligible.sms.length, email: eligible.email.length };

  // Requirement 17.12: zero eligible rows on every target channel sends nothing, writes nothing,
  // and leaves Case_Status alone. Returned before any template read, any render, and any provider.
  const targetedRecipients = channels.reduce((total, channel) => total + eligible[channel].length, 0);
  if (targetedRecipients === 0) {
    return reject('no_eligible_contact', NO_ELIGIBLE_CONTACT_MESSAGE, 422);
  }

  const communicationRead = await readRows<StoredCommunicationRow>(
    () => client.from(COMMUNICATIONS_TABLE).select(COMMUNICATION_COLUMNS).in('case_id', [input.caseId]),
    'read_communications',
  );
  if (communicationRead.failure !== null) summary.failures.push(communicationRead.failure);
  const storedByKey = new Map<string, StoredCommunicationRow>();
  for (const row of communicationRead.rows) {
    if (typeof row.id !== 'string' || row.id.length === 0) continue;
    storedByKey.set(keyOf(row.contact_id ?? '', row.touchpoint, row.channel), row);
  }

  // Templates, phrases, and the assigned employee are needed only where something is rendered —
  // that is, only where `Send Reminder Now` meets a key with no stored row. A retry re-sends stored
  // text, so the reads are deferred and skipped entirely when nothing will be rendered.
  let renderInputs: RenderInputs | null = null;
  const loadRenderInputs = async (): Promise<RenderInputs> => {
    if (renderInputs !== null) return renderInputs;
    renderInputs = await readRenderInputs(client, caseRow, summary);
    return renderInputs;
  };

  const retryEvents: Record<string, unknown>[] = [];
  const writtenRows: CommunicationRecord[] = [];
  const updatedKeys: string[] = [];
  const blockedByGate: string[] = [];

  // ── 5. One message per (contact, channel), in channel order and then stored contact order.
  for (const channel of channels) {
    for (const contact of eligible[channel]) {
      const key = keyOf(contact.id, touchpoint, channel);
      const stored = storedByKey.get(key);
      const recipient = (contact.normalized_value ?? '').trim();

      // Requirement 17.11: a stored row that is not failed is not sent to and stores nothing.
      if (stored !== undefined && stored.delivery_result !== 'Failed') {
        pushSkip(summary, contact.id, channel, touchpoint, recipient, 'already_sent');
        summary.alreadySent += 1;
        continue;
      }

      // The retry targets only a stored failed row; a key with none has nothing to retry.
      if (stored === undefined && input.action === RETRY_FAILED_ACTION) {
        pushSkip(summary, contact.id, channel, touchpoint, recipient, 'no_failed_record');
        continue;
      }

      // Requirement 23.3: with no email credentials, zero rows are written for an email key so a
      // later send may still take it. Asserted here as well as in `sendCommunication` because the
      // resend path calls the provider directly.
      if (channel === 'email' && !emailConfigured) {
        pushSkip(summary, contact.id, channel, touchpoint, recipient, 'email_not_configured');
        continue;
      }

      if (recipient.length === 0) {
        pushSkip(summary, contact.id, channel, touchpoint, recipient, 'recipient_absent');
        continue;
      }

      if (stored !== undefined) {
        // ── The Requirement 17.6 resend: stored text out, outcome onto the stored row.
        const outcome = await resendStoredRow({
          client,
          stored,
          channel,
          touchpoint,
          contactId: contact.id,
          recipient,
          senderDisplayName: (await loadRenderInputs()).senderDisplayName,
          replyTo: input.replyTo ?? null,
          providers: input.providers,
          sleep: input.sleep,
          backoffMs: input.backoffMs,
          now,
          summary,
          actor: input.actor,
        });
        summary.keys.push(outcome.key);
        if (outcome.key.status === 'sent') summary.counts.sent += 1;
        else summary.counts.failed += 1;
        summary.communicationRowsUpdated += outcome.recorded ? 1 : 0;
        updatedKeys.push(key);
        writtenRows.push(outcome.record);
        if (outcome.event !== null) retryEvents.push(outcome.event);
        continue;
      }

      // ── A key with no stored row: render, then reserve-then-send through the 14.2 helper.
      const inputs = await loadRenderInputs();
      let rendered: RenderResult;
      try {
        rendered = renderMessage({
          templateVersions: inputs.templateVersions,
          cases: [
            {
              id: caseRow.id,
              policy_number: caseRow.policy_number,
              cancellation_effective_date: caseRow.cancellation_effective_date,
              customer_name: caseRow.customer_name,
              carrier: caseRow.carrier,
              cancellation_reason: caseRow.cancellation_reason,
              amount_due: caseRow.amount_due,
              touchpoint,
            },
          ],
          contact: [
            {
              id: contact.id,
              channel: contact.channel,
              normalized_value: contact.normalized_value,
              preferred_language: contact.preferred_language,
              contact_name: contact.contact_name,
            },
          ],
          touchpoint,
          channel: channel as RenderChannel,
          settings,
          senderName: inputs.senderName,
          combined: false,
          prohibitedPhrases: inputs.prohibitedPhrases,
        });
      } catch (caught) {
        summary.counts.failed += 1;
        summary.keys.push({
          contactId: contact.id,
          channel,
          touchpoint,
          recipient,
          status: 'failed',
          reason: null,
          communicationId: null,
          deliveryResult: null,
          providerMessageId: null,
          failureReason: errorText(caught, 'The message could not be rendered.'),
          attemptCount: null,
          updatedExistingRow: false,
        });
        summary.failures.push({
          stage: 'render',
          contactId: contact.id,
          channel,
          message: errorText(caught, 'The message could not be rendered.'),
          code: null,
        });
        continue;
      }

      // Requirements 14.9 and 14.10: zero provider calls, zero rows, a block entry, and
      // Manual Follow-up Required on the case. `sendCommunication` refuses a blocked render too;
      // the audit entry and the status write belong to the caller.
      if (rendered.ok === false) {
        summary.blockedMessages += 1;
        pushSkip(summary, contact.id, channel, touchpoint, recipient, 'render_blocked');
        blockedByGate.push(key);
        await recordGateBlock({
          client,
          summary,
          caseId: caseRow.id,
          actorId: input.actor.profileId,
          blocked: rendered,
          channel,
          touchpoint,
          at: now(),
        });
        continue;
      }

      const outcome = await sendCommunication({
        channel: channel as RenderChannel,
        recipient,
        rendered,
        targets: [{ caseId: caseRow.id, contactId: contact.id, touchpoint }],
        client,
        ...(input.providers === undefined ? {} : { providers: input.providers }),
        now,
        ...(input.sleep === undefined ? {} : { sleep: input.sleep }),
        ...(input.backoffMs === undefined ? {} : { backoffMs: input.backoffMs }),
        ...(input.newGroupId === undefined ? {} : { newGroupId: input.newGroupId }),
        replyTo: input.replyTo ?? null,
      });

      summary.linkRowsWritten += outcome.linkRowsWritten;
      summary.communicationRowsWritten += outcome.keys.length;

      for (const sent of outcome.keys) {
        summary.keys.push({
          contactId: contact.id,
          channel,
          touchpoint,
          recipient,
          status: sent.status,
          reason: null,
          communicationId: sent.communicationId,
          deliveryResult: sent.deliveryResult,
          providerMessageId: sent.providerMessageId,
          failureReason: sent.failureReason,
          attemptCount: sent.attemptCount,
          updatedExistingRow: false,
        });
        if (sent.status === 'sent') summary.counts.sent += 1;
        else summary.counts.failed += 1;
        writtenRows.push({
          id: sent.communicationId,
          case_id: caseRow.id,
          contact_id: contact.id,
          touchpoint,
          channel,
          delivery_result: sent.deliveryResult,
          send_time: null,
          failure_reason: sent.failureReason,
          attempt_count: sent.attemptCount,
          combined_group_id: outcome.combinedGroupId,
        });
      }

      for (const skipped of outcome.skipped) {
        pushSkip(
          summary,
          contact.id,
          channel,
          touchpoint,
          recipient,
          mapSendSkipReason(skipped.reason),
        );
      }

      for (const failure of outcome.failures) {
        summary.failures.push({
          stage: `send:${failure.stage}`,
          contactId: contact.id,
          channel,
          message: failure.message,
          code: failure.code,
        });
        if (failure.stage === 'reserve') summary.counts.failed += 1;
      }
    }
  }

  // ── 6a. Requirement 17.6: one retry entry per Contact_Recipient and channel, in one insert so
  //        the append-only timeline receives exactly the rows the updates produced.
  if (retryEvents.length > 0) {
    const failure = await writeRows(
      () => client.from(EVENTS_TABLE).insert(retryEvents),
      'retry_event',
    );
    if (failure === null) summary.retryEventsWritten = retryEvents.length;
    else summary.failures.push(failure);
  }

  // ── 6b. Requirement 15.9: a stored row and a changed delivery result both recompute
  //        Communication_Status. Nothing written means nothing to recompute, which is also the
  //        zero-rows guarantee of Requirement 17.12 on the paths that reach here having sent
  //        nothing. A case whose message the gate blocked keeps the Manual Follow-up Required the
  //        block wrote, exactly as the batch leaves it.
  const wrote = summary.communicationRowsWritten > 0 || summary.communicationRowsUpdated > 0;
  if (input.recomputeStatus !== false && wrote && blockedByGate.length === 0) {
    const merged = mergeCommunications(communicationRead.rows, writtenRows, updatedKeys);
    const scheduled = scheduledSendsFor(caseRow, eligible, businessDate);
    const pending = pendingTouchpointChannelSends(scheduled, merged);
    const failure = await writeRows(
      () => client.rpc(RECOMPUTE_RPC, { p_case_id: caseRow.id, p_pending_sends: pending.length }),
      'recompute_status',
    );
    if (failure === null) summary.statusRecomputed = true;
    else summary.failures.push(failure);
  }

  return { ok: true, summary };
}

// ---------------------------------------------------------------------------
// The resend of a stored failed row (Requirement 17.6)
// ---------------------------------------------------------------------------

interface ResendInput {
  client: SupabaseClient;
  stored: StoredCommunicationRow;
  channel: SuppressionChannel;
  touchpoint: Touchpoint;
  contactId: string;
  recipient: string;
  senderDisplayName: string;
  replyTo: string | null;
  providers?: SendProviders;
  sleep?: (ms: number) => Promise<void>;
  backoffMs?: readonly number[];
  now: () => Date;
  summary: ManualSendSummary;
  actor: ManualSendActor;
}

interface ResendOutcome {
  key: ManualSendKeyOutcome;
  record: CommunicationRecord;
  /** False where `cancellation_retry_communication` refused the write. */
  recorded: boolean;
  /** The retry entry to append, or `null` where the update did not land. */
  event: Record<string, unknown> | null;
}

/**
 * Submits the **stored** subject and body to the provider and writes the outcome onto the stored
 * row through `cancellation_retry_communication` — the only update path the immutability trigger
 * admits — so `template_version_id`, `rendered_subject`, and `rendered_body` stay byte-identical
 * and no second row is stored for the Idempotency_Key (Requirements 17.6, 14.16, 12.6).
 *
 * `attempt_count` is the stored count plus the attempts this resend made: the retry function
 * refuses to lower it, and a retry counts up.
 */
async function resendStoredRow(input: ResendInput): Promise<ResendOutcome> {
  const storedSubject = input.stored.rendered_subject ?? '';
  const storedBody = input.stored.rendered_body ?? '';

  const provider = await deliverMessage({
    channel: input.channel as RenderChannel,
    recipient: input.recipient,
    subject: input.channel === 'sms' ? '' : storedSubject,
    body: storedBody,
    senderDisplayName: input.senderDisplayName,
    replyTo: input.replyTo,
    ...(input.providers === undefined ? {} : { providers: input.providers }),
    ...(input.sleep === undefined ? {} : { sleep: input.sleep }),
    ...(input.backoffMs === undefined ? {} : { backoffMs: input.backoffMs }),
  });

  const deliveryResult: DeliveryResult = provider.success ? 'Sent' : 'Failed';
  const failureReason = provider.success ? null : provider.failureReason;
  const attemptCount = Math.max(1, input.stored.attempt_count ?? 1) + provider.attempts;
  const sendTime = input.now();

  const recorded = await recordProviderOutcome({
    communicationId: input.stored.id,
    deliveryResult,
    providerMessageId: provider.messageId,
    failureReason,
    attemptCount,
    sendTime,
    client: input.client,
  });

  if (!recorded.ok) {
    input.summary.failures.push({
      stage: recorded.failure.stage,
      contactId: input.contactId,
      channel: input.channel,
      message: recorded.failure.message,
      code: recorded.failure.code,
    });
  }

  const key: ManualSendKeyOutcome = {
    contactId: input.contactId,
    channel: input.channel,
    touchpoint: input.touchpoint,
    recipient: input.recipient,
    status: provider.success ? 'sent' : 'failed',
    reason: null,
    communicationId: input.stored.id,
    deliveryResult,
    providerMessageId: provider.messageId,
    failureReason,
    attemptCount,
    updatedExistingRow: recorded.ok,
  };

  const record: CommunicationRecord = {
    id: input.stored.id,
    case_id: input.stored.case_id ?? null,
    contact_id: input.contactId,
    touchpoint: input.touchpoint,
    channel: input.channel,
    delivery_result: recorded.ok ? deliveryResult : input.stored.delivery_result,
    send_time: null,
    failure_reason: recorded.ok ? failureReason : input.stored.failure_reason ?? null,
    attempt_count: recorded.ok ? attemptCount : input.stored.attempt_count ?? null,
    combined_group_id: input.stored.combined_group_id ?? null,
  };

  const event = recorded.ok
    ? {
        case_id: input.stored.case_id ?? null,
        actor_id: input.actor.profileId,
        event_type: COMMUNICATION_RETRIED_EVENT_TYPE,
        event_time: sendTime.toISOString(),
        detail: {
          communication_id: input.stored.id,
          contact_id: input.contactId,
          channel: input.channel,
          touchpoint: input.touchpoint,
          delivery_result: deliveryResult,
          provider_message_id: provider.messageId,
          failure_reason: failureReason,
          attempt_count: attemptCount,
          attempts_this_retry: provider.attempts,
          // Carried to state on the record that the three immutable values did not move.
          template_version_id: input.stored.template_version_id ?? null,
        },
      }
    : null;

  return { key, record, recorded: recorded.ok, event };
}

// ---------------------------------------------------------------------------
// The content-gate block (Requirements 14.9, 14.10)
// ---------------------------------------------------------------------------

interface GateBlockInput {
  client: SupabaseClient;
  summary: ManualSendSummary;
  caseId: string;
  actorId: string | null;
  blocked: Extract<RenderResult, { ok: false }>;
  channel: SuppressionChannel;
  touchpoint: Touchpoint;
  at: Date;
}

/**
 * The two writes a blocked message produces: one `cancellation_events` entry carrying the matched
 * phrase or token, and `communication_status = 'Manual Follow-up Required'` on the case. No
 * Communication_Record is written and no provider was called — the block happened inside
 * `renderMessage`, before this function was reached. `case_status` is untouched.
 */
async function recordGateBlock(input: GateBlockInput): Promise<void> {
  const eventTime = input.at.toISOString();

  const eventFailure = await writeRows(
    () => input.client.from(EVENTS_TABLE).insert({
      case_id: input.caseId,
      actor_id: input.actorId,
      event_type: SEND_BLOCKED_EVENT_TYPE,
      event_time: eventTime,
      detail: {
        blocked_by: input.blocked.blockedBy,
        match: input.blocked.match,
        field: input.blocked.field ?? null,
        channel: input.channel,
        touchpoint: input.touchpoint,
        covered_case_ids: [input.caseId],
      },
    }),
    'block_event',
  );
  if (eventFailure !== null) input.summary.failures.push(eventFailure);

  const statusFailure = await writeRows(
    () => input.client
      .from(CASES_TABLE)
      .update({ communication_status: MANUAL_FOLLOW_UP_STATUS })
      .in('id', [input.caseId]),
    'block_status',
  );
  if (statusFailure !== null) input.summary.failures.push(statusFailure);
}

// ---------------------------------------------------------------------------
// Render inputs, read once and only where something is rendered
// ---------------------------------------------------------------------------

interface RenderInputs {
  templateVersions: TemplateVersionRow[];
  prohibitedPhrases: ProhibitedPhraseRow[];
  senderName: AssignedEmployee | null;
  /** The email from display name; the agency name where the case has no usable assignee. */
  senderDisplayName: string;
}

/**
 * The template versions, the active prohibited phrases, and the assigned employee.
 *
 * `joinTemplateTouchpoints` attaches each version row's Touchpoint from `cancellation_templates`,
 * which is what lets `renderMessage` pick the 15, 10, 5, or 1-day template while staying pure. The
 * `(Deleted)` producer-label suffix of Requirement 9.7 is the only deletion marker the data
 * carries, so it is what `is_deleted` reads (Requirements 14.13, 14.14).
 */
async function readRenderInputs(
  client: SupabaseClient,
  caseRow: SchedulerCaseRow,
  summary: ManualSendSummary,
): Promise<RenderInputs> {
  const templateRead = await readRows<{ id: string; touchpoint: Touchpoint }>(
    () => client.from(TEMPLATES_TABLE).select(TEMPLATE_COLUMNS),
    'read_templates',
  );
  if (templateRead.failure !== null) summary.failures.push(templateRead.failure);

  const versionRead = await readRows<TemplateVersionRow>(
    () => client.from(TEMPLATE_VERSIONS_TABLE).select(TEMPLATE_VERSION_COLUMNS),
    'read_template_versions',
  );
  if (versionRead.failure !== null) summary.failures.push(versionRead.failure);

  const phraseRead = await readRows<ProhibitedPhraseRow>(
    () => client.from(PHRASES_TABLE).select(PHRASE_COLUMNS),
    'read_prohibited_phrases',
  );
  if (phraseRead.failure !== null) summary.failures.push(phraseRead.failure);

  const assignedTo = typeof caseRow.assigned_to === 'string' && caseRow.assigned_to.length > 0
    ? caseRow.assigned_to
    : null;

  let profile: SchedulerProfileRow | null = null;
  if (assignedTo !== null) {
    const profileRead = await readRows<SchedulerProfileRow>(
      () => client.from(PROFILES_TABLE).select(PROFILE_COLUMNS).in('id', [assignedTo]),
      'read_profiles',
    );
    if (profileRead.failure !== null) summary.failures.push(profileRead.failure);
    profile = profileRead.rows.find((row) => row.id === assignedTo) ?? null;
  }

  const senderName: AssignedEmployee | null = profile === null
    ? null
    : {
        display_name: profile.display_name,
        is_active: profile.is_active,
        is_deleted: hasDeletedSuffix(caseRow.producer_label),
      };

  const usableDisplayName =
    senderName !== null
    && senderName.is_active !== false
    && senderName.is_deleted !== true
    && typeof senderName.display_name === 'string'
    && senderName.display_name.trim().length > 0
      ? senderName.display_name
      : null;

  return {
    templateVersions: joinTemplateTouchpoints(versionRead.rows, templateRead.rows),
    prohibitedPhrases: phraseRead.rows,
    senderName,
    senderDisplayName: usableDisplayName ?? 'New Hope Insurance Agency',
  };
}

// ---------------------------------------------------------------------------
// The HTTP path
// ---------------------------------------------------------------------------

/** The parsed request body. */
export interface ManualSendRequestBody {
  caseId: string;
  action: ManualSendAction;
  /** Absent or `both` targets every channel, which is what Requirement 17.5 describes. */
  channel?: SuppressionChannel | 'both';
}

export interface ManualSendRequestOptions {
  /** The session reader seam, so a test drives every role with no cookies. */
  resolveSession?: SchedulerSessionResolver;
  /** Overrides for the work function, so a test can inject a client, providers, and a clock. */
  run?: Partial<Omit<ManualSendInput, 'client' | 'caseId' | 'action' | 'actor'>> & {
    client?: SupabaseClient;
  };
  /** The work seam itself, so an authorization test needs no store at all. */
  runner?: (input: ManualSendInput) => Promise<ManualSendResult>;
}

/**
 * `POST /api/cancellations/send`, minus the route file.
 *
 * The order is the security contract. The session is resolved first, an unrecognized role and a
 * role outside the Policy Follow-up workspace are answered 403, and a `Retry Failed Communication`
 * from anything other than `manager` or `super_admin` is answered 403 — all of it before a Supabase
 * client is constructed, so an unauthorized request reaches no table and no provider
 * (Requirements 17.10, 22.6). The case-scope refusal of Requirements 22.2 and 22.6 needs the case
 * row and is the first thing `runManualSend` does.
 */
export async function handleManualSendRequest(
  request: Request,
  options: ManualSendRequestOptions = {},
): Promise<Response> {
  const resolve = options.resolveSession ?? resolveSessionProfile;
  const session = await resolve();
  const role = session === null ? null : readSchedulerRole(session.role);
  if (session === null || role === null || !roleMayUseManualSend(role)) {
    return Response.json(
      { error: ROLE_NOT_PERMITTED_MESSAGE, code: 'forbidden_role' satisfies ManualSendRejectionCode },
      { status: 403 },
    );
  }
  const actor: ManualSendActor = { profileId: session.profileId, role };

  const body = await readManualSendBody(request);
  if (!body.ok) {
    return Response.json({ error: body.rejection.message, code: body.rejection.code }, {
      status: body.rejection.status,
    });
  }

  // Requirement 17.10: the retry gate fails closed, before any client exists to write with.
  if (body.body.action === RETRY_FAILED_ACTION && !isBroadManagerRole(role)) {
    return Response.json(
      {
        error: RETRY_REQUIRES_MANAGER_MESSAGE,
        code: 'forbidden_role' satisfies ManualSendRejectionCode,
      },
      { status: 403 },
    );
  }

  const client = options.run?.client ?? createSchedulerServiceClient();
  if (client === null) return serviceRoleUnconfigured();

  const channels = channelsFromBody(body.body.channel);
  const runner = options.runner ?? runManualSend;
  const result = await runner({
    ...options.run,
    client,
    caseId: body.body.caseId,
    action: body.body.action,
    actor,
    channels: options.run?.channels ?? channels,
  });

  if (!result.ok) {
    return Response.json(
      { error: result.rejection.message, code: result.rejection.code },
      { status: result.rejection.status },
    );
  }

  return Response.json({ success: true, summary: result.summary });
}

/**
 * The request body, read without trusting a single field. A body that is not an object, a case
 * identifier that is not a non-empty string, an action outside the two, and a channel outside
 * `sms`, `email`, and `both` are all refused with zero rows written.
 */
export async function readManualSendBody(
  request: Request,
): Promise<{ ok: true; body: ManualSendRequestBody } | { ok: false; rejection: ManualSendRejection }> {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return { ok: false, rejection: { code: 'invalid_request', message: INVALID_REQUEST_MESSAGE, status: 400 } };
  }
  return parseManualSendBody(payload);
}

/** The body reader, over an already-decoded value, so a test needs no `Request`. */
export function parseManualSendBody(
  payload: unknown,
): { ok: true; body: ManualSendRequestBody } | { ok: false; rejection: ManualSendRejection } {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return { ok: false, rejection: { code: 'invalid_request', message: INVALID_REQUEST_MESSAGE, status: 400 } };
  }
  const record = payload as Record<string, unknown>;
  const caseId = typeof record.caseId === 'string' ? record.caseId.trim() : '';
  const action = record.action;
  const channel = record.channel;

  if (caseId.length === 0 || !MANUAL_SEND_ACTIONS.includes(action as ManualSendAction)) {
    return { ok: false, rejection: { code: 'invalid_request', message: INVALID_REQUEST_MESSAGE, status: 400 } };
  }
  if (
    channel !== undefined
    && channel !== null
    && channel !== 'both'
    && channel !== 'sms'
    && channel !== 'email'
  ) {
    return { ok: false, rejection: { code: 'invalid_request', message: INVALID_REQUEST_MESSAGE, status: 400 } };
  }

  return {
    ok: true,
    body: {
      caseId,
      action: action as ManualSendAction,
      ...(channel === undefined || channel === null ? {} : { channel: channel as SuppressionChannel | 'both' }),
    },
  };
}

/** The channels a body targets: the named one, or both. */
export function channelsFromBody(
  channel: SuppressionChannel | 'both' | undefined,
): SuppressionChannel[] {
  if (channel === 'sms' || channel === 'email') return [channel];
  return [...SUPPRESSION_CHANNELS];
}

// ---------------------------------------------------------------------------
// Reading and writing, every call wrapped
// ---------------------------------------------------------------------------

interface ReadResult<TRow> {
  rows: TRow[];
  failure: ManualSendFailure | null;
}

interface PostgrestLike {
  data?: unknown;
  error?: unknown;
}

/**
 * One read, with every failure mode reduced to data: a returned error, a rejected promise, and a
 * client that throws synchronously all produce an empty row list and a recorded failure.
 */
async function readRows<TRow>(build: () => unknown, stage: string): Promise<ReadResult<TRow>> {
  try {
    const result = (await build()) as PostgrestLike | null | undefined;
    const error = result?.error;
    if (error !== null && error !== undefined) {
      return {
        rows: [],
        failure: {
          stage,
          contactId: null,
          channel: null,
          message: errorText(error, `The ${stage} query failed.`),
          code: errorCode(error),
        },
      };
    }
    const data = result?.data;
    return { rows: Array.isArray(data) ? (data as TRow[]) : [], failure: null };
  } catch (caught) {
    return {
      rows: [],
      failure: {
        stage,
        contactId: null,
        channel: null,
        message: errorText(caught, `The ${stage} query failed.`),
        code: errorCode(caught),
      },
    };
  }
}

/** One write. Returns the failure, or `null` where it succeeded. */
async function writeRows(build: () => unknown, stage: string): Promise<ManualSendFailure | null> {
  try {
    const result = (await build()) as PostgrestLike | null | undefined;
    const error = result?.error;
    if (error === null || error === undefined) return null;
    return {
      stage,
      contactId: null,
      channel: null,
      message: errorText(error, `The ${stage} write failed.`),
      code: errorCode(error),
    };
  } catch (caught) {
    return {
      stage,
      contactId: null,
      channel: null,
      message: errorText(caught, `The ${stage} write failed.`),
      code: errorCode(caught),
    };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function reject(
  code: ManualSendRejectionCode,
  message: string,
  status: number,
): { ok: false; rejection: ManualSendRejection } {
  return { ok: false, rejection: { code, message, status } };
}

function resolveChannels(channels: readonly SuppressionChannel[] | undefined): SuppressionChannel[] {
  if (channels === undefined) return [...SUPPRESSION_CHANNELS];
  const unique: SuppressionChannel[] = [];
  for (const channel of SUPPRESSION_CHANNELS) {
    if (channels.includes(channel)) unique.push(channel);
  }
  return unique.length > 0 ? unique : [...SUPPRESSION_CHANNELS];
}

/** Requirements 22.2, 22.6, 22.12: a non-manager writes only to a record assigned to itself. */
function isAssignedTo(caseRow: SchedulerCaseRow, actor: ManualSendActor): boolean {
  const assignedTo = typeof caseRow.assigned_to === 'string' ? caseRow.assigned_to.trim() : '';
  const profileId = actor.profileId.trim();
  return assignedTo.length > 0 && profileId.length > 0 && assignedTo === profileId;
}

function keyOf(contactId: string, touchpoint: Touchpoint, channel: SuppressionChannel): string {
  return `${contactId}|${touchpoint}|${channel}`;
}

function pushSkip(
  summary: ManualSendSummary,
  contactId: string,
  channel: SuppressionChannel,
  touchpoint: Touchpoint,
  recipient: string,
  reason: ManualSendSkipReason,
): void {
  summary.keys.push({
    contactId,
    channel,
    touchpoint,
    recipient,
    status: 'skipped',
    reason,
    communicationId: null,
    deliveryResult: null,
    providerMessageId: null,
    failureReason: null,
    attemptCount: null,
    updatedExistingRow: false,
  });
  summary.counts.skipped += 1;
}

/** `SendSkipReason` onto this route's vocabulary. */
function mapSendSkipReason(reason: string): ManualSendSkipReason {
  switch (reason) {
    case 'existing_record':
      return 'existing_record';
    case 'email_not_configured':
      return 'email_not_configured';
    case 'render_blocked':
      return 'render_blocked';
    default:
      return 'recipient_absent';
  }
}

/**
 * The case's Communication_Record set as it stands after the action: every stored row except the
 * ones this action updated, plus the rows it wrote or updated. That is what the Requirement 15.9
 * pending-send count is subtracted from.
 */
function mergeCommunications(
  stored: readonly StoredCommunicationRow[],
  written: readonly CommunicationRecord[],
  updatedKeys: readonly string[],
): CommunicationRecord[] {
  const replaced = new Set(updatedKeys);
  const merged: CommunicationRecord[] = [];
  for (const row of stored) {
    if (replaced.has(keyOf(row.contact_id ?? '', row.touchpoint, row.channel))) continue;
    merged.push(row);
  }
  return [...merged, ...written];
}

function errorCode(error: unknown): string | null {
  if (error === null || error === undefined || typeof error !== 'object') return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && code.length > 0 ? code : null;
}

function errorText(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim().length > 0) return error.message;
  if (error !== null && error !== undefined && typeof error === 'object') {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string' && message.trim().length > 0) return message;
  }
  return fallback;
}
