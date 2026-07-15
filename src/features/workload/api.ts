"use client";

import { getSupabase } from "../nhwd-shared/client";

export type WorkloadType =
  | "activation"
  | "change"
  | "payment"
  | "whatsapp_update";

export interface WorkloadLogRow {
  id: string;
  customer_name: string;
  work_type: WorkloadType;
  change_type: string | null;
  assignment_method: string;
  status: string;
  assigned_profile_id: string;
  assigned_name: string | null;
  assigned_username: string | null;
  assigned_role: string | null;
  original_owner_name: string | null;
  dealer_name: string | null;
  salesperson_name: string | null;
  created_at: string;
  assigned_at: string | null;
  accepted_at: string | null;
  completed_at: string | null;
  received_through: string | null;
  note: string | null;
  related_quote_source_work_item_id: string | null;
  is_voided: boolean;
  voided_at: string | null;
  void_reason: string | null;
  voided_by_name: string | null;
  correction_history: Array<{
    event_type: 'workload_reassigned' | 'workload_voided' | string;
    created_at: string;
    actor_name: string | null;
    details: Record<string, unknown> | null;
  }>;
}

export interface WorkloadAssignee {
  id: string;
  username: string;
  display_name: string;
  role: "agent" | "customer_service";
}

function throwIfError(error: { message?: string } | null) {
  if (error) {
    throw new Error(error.message || "The workload request could not be completed.");
  }
}

export async function listWorkloadLog(input: {
  from: string;
  to: string;
  includeVoided: boolean;
}): Promise<WorkloadLogRow[]> {
  const { data, error } = await getSupabase().rpc("workload_log_list", {
    p_from: input.from,
    p_to: input.to,
    p_include_voided: input.includeVoided,
  });

  throwIfError(error);
  return Array.isArray(data) ? (data as WorkloadLogRow[]) : [];
}

export async function listWorkloadAssignees(): Promise<WorkloadAssignee[]> {
  const { data, error } = await getSupabase()
    .from("profiles")
    .select("id,username,display_name,role")
    .eq("is_active", true)
    .in("role", ["agent", "customer_service"])
    .order("role")
    .order("display_name");

  throwIfError(error);
  return (data ?? []) as WorkloadAssignee[];
}

export async function reassignWorkload(
  workItemId: string,
  profileId: string,
  reason: string,
): Promise<void> {
  const { error } = await getSupabase().rpc("workload_reassign", {
    p_work_item_id: workItemId,
    p_profile_id: profileId,
    p_reason: reason,
  });

  throwIfError(error);
}

export async function voidWorkload(
  workItemId: string,
  reason: string,
): Promise<void> {
  const { error } = await getSupabase().rpc("workload_void", {
    p_work_item_id: workItemId,
    p_reason: reason,
  });

  throwIfError(error);
}
