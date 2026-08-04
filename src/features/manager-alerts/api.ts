'use client';

import { getSupabase } from '../nhwd-shared/client';

/**
 * Red operational SLA alerts for managers and supervisors.
 *
 * Backed by public.manager_sla_alerts() — see
 * supabase/migrations/v1.11.1-manager-sla-alerts.sql. The role check lives
 * inside that function, so an agent calling this gets an error rather than data.
 */

export type ManagerAlertKind = 'unclaimed_personal_intake' | 'fast_price_sent';

export interface ManagerSlaAlert {
  /** Stable per-entity key. Safe to use as a React key. */
  alert_key: string;
  alert_kind: ManagerAlertKind;
  severity: 'red';
  entity_type: 'cs_intake' | 'quote';
  entity_id: string;
  /** Present for quote alerts; use it to open the Quote Activity log. */
  source_work_item_id: string | null;
  customer_name: string;
  /** Responsible agent, or the current RingCentral turn holder for queued intakes. */
  agent_name: string | null;
  detail: string | null;
  elapsed_minutes: number;
  occurred_at: string;
}

/** Minutes an unclaimed personal-lines intake may sit before it turns red. */
export const INTAKE_CLAIM_SLA_MINUTES = 15;

/** A price sent sooner than this after quote creation turns red. */
export const FAST_PRICE_SLA_MINUTES = 7;

/** How far back the fast-pricing alert looks. */
export const ALERT_LOOKBACK_HOURS = 24;

export async function listManagerSlaAlerts(): Promise<ManagerSlaAlert[]> {
  const { data, error } = await getSupabase().rpc('manager_sla_alerts', {
    p_intake_claim_minutes: INTAKE_CLAIM_SLA_MINUTES,
    p_fast_price_minutes: FAST_PRICE_SLA_MINUTES,
    p_lookback_hours: ALERT_LOOKBACK_HOURS,
  });
  if (error) throw new Error(error.message || 'Unable to load operational alerts.');
  return (data as ManagerSlaAlert[]) ?? [];
}

export function managerAlertHeadline(alert: ManagerSlaAlert): string {
  if (alert.alert_kind === 'unclaimed_personal_intake') {
    return `Personal intake unclaimed for ${formatMinutes(alert.elapsed_minutes)}`;
  }
  return `Price sent ${formatMinutes(alert.elapsed_minutes)} after the quote was created`;
}

function formatMinutes(minutes: number): string {
  if (minutes <= 0) return 'under a minute';
  if (minutes === 1) return '1 minute';
  if (minutes < 60) return `${minutes} minutes`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  const hoursLabel = hours === 1 ? '1 hour' : `${hours} hours`;
  if (!rest) return hoursLabel;
  return `${hoursLabel} ${rest} min`;
}
