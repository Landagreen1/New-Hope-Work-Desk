// src/features/cs-intake/history-helpers.ts
// Pure helper functions for building intake history events

import type { IntakeHistoryEvent } from '../quotes/types';

/**
 * Represents a single field change with old and new values.
 */
export interface FieldChange {
  field: string;
  old_value: unknown;
  new_value: unknown;
}

/**
 * Parameters for building a grouped history event.
 */
export interface BuildGroupedHistoryEventParams {
  intakeId: string;
  linkedQuoteId: string | null;
  actorId: string;
  actorDisplayName: string;
  reason: string | null;
  changes: FieldChange[];
}

/**
 * Builds a single grouped IntakeHistoryEvent from a set of field changes.
 *
 * When multiple fields are edited simultaneously, this produces ONE history event
 * containing all changed fields in its changed_fields array. Each changed field
 * entry has: field name, old_value, and new_value.
 *
 * Validates Requirements 2.3, 4.3:
 * - Multiple field edits produce a single grouped history event
 * - Each entry contains field name, old value, new value
 * - Editor identity and timestamp are recorded
 *
 * @returns A single IntakeHistoryEvent with all changes grouped together
 * @throws Error if changes array is empty
 */
export function buildGroupedHistoryEvent(
  params: BuildGroupedHistoryEventParams
): IntakeHistoryEvent {
  const { intakeId, linkedQuoteId, actorId, actorDisplayName, reason, changes } = params;

  if (changes.length === 0) {
    throw new Error('Cannot create a history event with no field changes');
  }

  const changedFields = changes.map((change) => ({
    field: change.field,
    old_value: change.old_value,
    new_value: change.new_value,
  }));

  return {
    id: crypto.randomUUID(),
    intake_id: intakeId,
    linked_quote_id: linkedQuoteId,
    actor_id: actorId,
    actor_display_name: actorDisplayName,
    event_type: 'updated',
    changed_fields: changedFields,
    details: `${actorDisplayName} updated ${changes.length} field(s)`,
    reason,
    created_at: new Date().toISOString(),
  };
}
