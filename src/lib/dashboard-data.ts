import type { SupabaseClient } from "@supabase/supabase-js";

import type {
  Agent,
  AlertNotification,
  AssignmentMethod,
  DashboardData,
  SourceOption,
  PassEvent,
  PerformanceRow,
  QuoteOutcome,
  QuoteNote,
  QuoteActivity,
  QuoteTakeEvent,
  QuoteTakeTimer,
  WorkDeskSettings,
  RotationKind,
  WorkItem,
  WorkStatus,
  WorkType,
  PendingPricingItem,
  NotSoldReason,
} from "@/lib/types";

type ProfileRow = {
  id: string;
  username: string;
  display_name: string;
  initials: string;
  role: "agent" | "manager";
  rotation_position: number;
  whatsapp_position: number;
  ringcentral_position: number;
  workload_position: number;
  availability: Agent["availability"];
  whatsapp_active: boolean;
  ringcentral_active: boolean;
  workload_active: boolean;
  is_active: boolean;
};

type DealerRow = { id: string; name: string; is_active: boolean };

type WorkRow = {
  id: string;
  customer_name: string;
  dealer_id: string | null;
  work_type: WorkType;
  original_owner_profile_id: string | null;
  assigned_profile_id: string;
  assignment_method: AssignmentMethod;
  status: string;
  change_type: string | null;
  note: string | null;
  received_through: string | null;
  created_at: string;
  assigned_at: string | null;
  accepted_at: string | null;
  completed_at: string | null;
  related_quote_source_work_item_id: string | null;
};

type PendingRow = {
  id: string;
  source_work_item_id: string;
  customer_name: string;
  dealer_id: string | null;
  work_type: "new_quote" | "requote";
  original_owner_profile_id: string | null;
  assigned_profile_id: string;
  assignment_method: AssignmentMethod;
  received_through: string | null;
  note: string | null;
  quote_created_at: string;
  assigned_at: string | null;
  accepted_at: string | null;
  price_sent_at: string;
};

type OutcomeRow = {
  id: string;
  source_work_item_id: string;
  customer_name: string;
  dealer_id: string | null;
  work_type: "new_quote" | "requote";
  original_owner_profile_id: string | null;
  assigned_profile_id: string;
  assignment_method: AssignmentMethod;
  received_through: string | null;
  quote_created_at: string;
  assigned_at: string | null;
  accepted_at: string | null;
  price_sent_at: string | null;
  finalized_at: string;
  decision: "sold" | "not_sold";
  not_sold_reason: NotSoldReason | null;
  not_sold_reason_other: string | null;
};


type QuoteNoteRow = {
  id: string;
  source_work_item_id: string;
  author_profile_id: string;
  note: string;
  created_at: string;
};



type WorkItemEventRow = {
  id: string;
  source_work_item_id: string;
  event_type: string;
  actor_profile_id: string | null;
  assigned_profile_id: string | null;
  details: Record<string, unknown> | null;
  created_at: string;
};

type QuoteTakeEventRow = {
  id: string;
  source_work_item_id: string;
  rotation: "whatsapp" | "ringcentral";
  received_at: string;
  taken_at: string;
  taker_profile_id: string;
  skipped_profile_ids: string[] | null;
  elapsed_seconds: number;
};

type QuoteTakeTimerRow = {
  id: string;
  rotation: "whatsapp" | "ringcentral";
  current_profile_id: string;
  started_by_profile_id: string;
  received_at: string;
  deadline_at: string;
  customer_name: string;
  dealer_id: string | null;
  work_type: "new_quote" | "requote";
  note: string | null;
  status: "active" | "claimed" | "stolen" | "cancelled";
  started_at: string;
  warning_sent_at: string | null;
};

type WorkDeskSettingsRow = {
  customer_service_overflow_enabled: boolean;
  customer_service_profile_id: string | null;
};

type NotificationRow = {
  id: string;
  notification_type: "turn" | "assignment";
  title: string;
  message: string;
  entity_type: string | null;
  entity_id: string | null;
  created_at: string;
  read_at: string | null;
};

type PassEventRow = {
  id: string;
  rotation: RotationKind;
  actor_profile_id: string;
  created_at: string;
  reason: string | null;
};

type PerformanceDbRow = {
  profile_id: string;
  whatsapp_quotes: number;
  ringcentral_quotes: number;
  workload_turns: number;
  whatsapp_updates: number;
  manual_quotes: number;
  sold_quotes: number;
  owned_activations: number;
  owned_changes: number;
  requotes: number;
  passed_turns: number;
};

function asWorkStatus(status: string): WorkStatus {
  return status === "completed" || status === "cancelled" ? status : "active";
}

export async function loadDashboardData(supabase: SupabaseClient): Promise<DashboardData> {
  const { error: dailyResetError } = await supabase.rpc("ensure_daily_availability_reset");
  if (dailyResetError) throw new Error(`Daily availability reset check failed: ${dailyResetError.message}`);

  const [profilesResult, dealersResult, rotationsResult, workResult, pendingResult, outcomesResult, quoteNotesResult, quoteActivitiesResult, quoteTakeEventsResult, quoteTakeTimersResult, settingsResult, notificationsResult, performanceResult, passEventsResult] = await Promise.all([
    supabase.from("profiles").select("id,username,display_name,initials,role,rotation_position,whatsapp_position,ringcentral_position,workload_position,availability,whatsapp_active,ringcentral_active,workload_active,is_active").eq("is_active", true).order("rotation_position"),
    supabase.from("dealers").select("id,name,is_active").order("name"),
    supabase.from("rotation_state").select("kind,current_profile_id"),
    supabase.from("work_items").select("id,customer_name,dealer_id,work_type,original_owner_profile_id,assigned_profile_id,assignment_method,status,change_type,note,received_through,created_at,assigned_at,accepted_at,completed_at,related_quote_source_work_item_id").order("created_at", { ascending: false }).limit(5000),
    supabase.from("pending_pricing_quotes").select("id,source_work_item_id,customer_name,dealer_id,work_type,original_owner_profile_id,assigned_profile_id,assignment_method,received_through,note,quote_created_at,assigned_at,accepted_at,price_sent_at").order("price_sent_at", { ascending: true }).limit(5000),
    supabase.from("quote_outcomes").select("id,source_work_item_id,customer_name,dealer_id,work_type,original_owner_profile_id,assigned_profile_id,assignment_method,received_through,quote_created_at,assigned_at,accepted_at,price_sent_at,finalized_at,decision,not_sold_reason,not_sold_reason_other").order("finalized_at", { ascending: false }).limit(10000),
    supabase.from("quote_notes").select("id,source_work_item_id,author_profile_id,note,created_at").order("created_at", { ascending: false }).limit(20000),
    supabase.from("work_item_events").select("id,source_work_item_id,event_type,actor_profile_id,assigned_profile_id,details,created_at").order("created_at", { ascending: false }).limit(30000),
    supabase.from("quote_take_events").select("id,source_work_item_id,rotation,received_at,taken_at,taker_profile_id,skipped_profile_ids,elapsed_seconds").order("taken_at", { ascending: false }).limit(10000),
    supabase.from("quote_take_timers").select("id,rotation,current_profile_id,started_by_profile_id,received_at,deadline_at,customer_name,dealer_id,work_type,note,status,started_at,warning_sent_at").eq("status", "active").order("started_at", { ascending: false }),
    supabase.from("work_desk_settings").select("customer_service_overflow_enabled,customer_service_profile_id").eq("singleton_id", true).maybeSingle(),
    supabase.from("user_notifications").select("id,notification_type,title,message,entity_type,entity_id,created_at,read_at").order("created_at", { ascending: false }).limit(100),
    supabase.from("daily_agent_performance").select("profile_id,whatsapp_quotes,ringcentral_quotes,workload_turns,whatsapp_updates,manual_quotes,sold_quotes,owned_activations,owned_changes,requotes,passed_turns"),
    supabase.from("turn_events").select("id,rotation,actor_profile_id,created_at,reason").eq("action", "pass").order("created_at", { ascending: false }).limit(10000),
  ]);

  const errors = [profilesResult.error, dealersResult.error, rotationsResult.error, workResult.error, pendingResult.error, outcomesResult.error, quoteNotesResult.error, quoteActivitiesResult.error, quoteTakeEventsResult.error, quoteTakeTimersResult.error, settingsResult.error, notificationsResult.error, performanceResult.error, passEventsResult.error].filter(Boolean);
  if (errors.length) throw new Error(errors[0]?.message || "Unable to load Work Desk data.");

  const profiles = (profilesResult.data || []) as ProfileRow[];
  const agentProfiles = profiles.filter((profile) => profile.role === "agent");
  const dealers = (dealersResult.data || []) as DealerRow[];
  const nameByProfile = new Map(profiles.map((profile) => [profile.id, profile.display_name]));
  const usernameByProfile = new Map(profiles.map((profile) => [profile.id, profile.username]));
  const dealerById = new Map(dealers.map((dealer) => [dealer.id, dealer.name]));

  const activeCountByAgent = new Map<string, number>();
  for (const row of (workResult.data || []) as WorkRow[]) {
    if (row.status === "active" && row.work_type !== "whatsapp_update") {
      activeCountByAgent.set(row.assigned_profile_id, (activeCountByAgent.get(row.assigned_profile_id) || 0) + 1);
    }
  }

  const agents: Agent[] = agentProfiles.map((profile) => ({
    id: profile.id,
    name: profile.display_name,
    initials: profile.initials,
    rotationPosition: profile.rotation_position,
    whatsappPosition: profile.whatsapp_position,
    ringCentralPosition: profile.ringcentral_position,
    workloadPosition: profile.workload_position,
    availability: profile.availability,
    whatsappActive: profile.whatsapp_active,
    ringCentralActive: profile.ringcentral_active,
    workloadActive: profile.workload_active,
    activeCount: activeCountByAgent.get(profile.id) || 0,
  }));

  const sourceOptions: SourceOption[] = dealers.filter((dealer) => dealer.is_active).map((dealer) => ({ id: dealer.id, name: dealer.name }));

  const workItems: WorkItem[] = ((workResult.data || []) as WorkRow[]).map((row) => ({
    id: row.id,
    createdAt: row.created_at,
    assignedAt: row.assigned_at || row.created_at,
    acceptedAt: row.accepted_at || undefined,
    customer: row.customer_name,
    dealer: row.dealer_id ? dealerById.get(row.dealer_id) || "Unknown source" : "Direct / No source",
    workType: row.work_type,
    originalOwner: row.original_owner_profile_id ? nameByProfile.get(row.original_owner_profile_id) : undefined,
    assignedAgent: nameByProfile.get(row.assigned_profile_id) || "Unknown agent",
    assignmentMethod: row.assignment_method,
    status: asWorkStatus(row.status),
    changeType: row.change_type || undefined,
    note: row.note || undefined,
    receivedThrough: row.received_through || undefined,
    completedAt: row.completed_at || undefined,
    relatedQuoteSourceWorkItemId: row.related_quote_source_work_item_id || undefined,
  }));

  const pendingPricing: PendingPricingItem[] = ((pendingResult.data || []) as PendingRow[]).map((row) => ({
    id: row.id,
    sourceWorkItemId: row.source_work_item_id,
    quoteCreatedAt: row.quote_created_at,
    assignedAt: row.assigned_at || row.quote_created_at,
    acceptedAt: row.accepted_at || row.quote_created_at,
    priceSentAt: row.price_sent_at,
    customer: row.customer_name,
    dealer: row.dealer_id ? dealerById.get(row.dealer_id) || "Unknown source" : "Direct / No source",
    workType: row.work_type,
    originalOwner: row.original_owner_profile_id ? nameByProfile.get(row.original_owner_profile_id) : undefined,
    assignedAgent: nameByProfile.get(row.assigned_profile_id) || "Unknown agent",
    assignmentMethod: row.assignment_method,
    receivedThrough: row.received_through || undefined,
    note: row.note || undefined,
  }));

  const quoteOutcomes: QuoteOutcome[] = ((outcomesResult.data || []) as OutcomeRow[]).map((row) => ({
    id: row.id,
    sourceWorkItemId: row.source_work_item_id,
    quoteCreatedAt: row.quote_created_at,
    assignedAt: row.assigned_at || row.quote_created_at,
    acceptedAt: row.accepted_at || row.quote_created_at,
    priceSentAt: row.price_sent_at || undefined,
    finalizedAt: row.finalized_at,
    customer: row.customer_name,
    dealer: row.dealer_id ? dealerById.get(row.dealer_id) || "Unknown source" : "Direct / No source",
    workType: row.work_type,
    originalOwner: row.original_owner_profile_id ? nameByProfile.get(row.original_owner_profile_id) : undefined,
    assignedAgent: nameByProfile.get(row.assigned_profile_id) || "Unknown agent",
    assignmentMethod: row.assignment_method,
    receivedThrough: row.received_through || undefined,
    decision: row.decision,
    notSoldReason: row.not_sold_reason || undefined,
    notSoldReasonOther: row.not_sold_reason_other || undefined,
  }));



  const quoteNotes: QuoteNote[] = ((quoteNotesResult.data || []) as QuoteNoteRow[]).map((row) => ({
    id: row.id,
    sourceWorkItemId: row.source_work_item_id,
    authorProfileId: row.author_profile_id,
    authorName: nameByProfile.get(row.author_profile_id) || "Unknown agent",
    authorUsername: usernameByProfile.get(row.author_profile_id) || "unknown",
    note: row.note,
    createdAt: row.created_at,
  }));

  const quoteActivities: QuoteActivity[] = ((quoteActivitiesResult.data || []) as WorkItemEventRow[]).map((row) => ({
    id: row.id,
    sourceWorkItemId: row.source_work_item_id,
    eventType: row.event_type,
    actorProfileId: row.actor_profile_id || undefined,
    actorName: row.actor_profile_id ? nameByProfile.get(row.actor_profile_id) || "Unknown user" : "System",
    actorUsername: row.actor_profile_id ? usernameByProfile.get(row.actor_profile_id) || "unknown" : "system",
    assignedAgent: row.assigned_profile_id ? nameByProfile.get(row.assigned_profile_id) || "Unknown agent" : undefined,
    details: row.details || undefined,
    createdAt: row.created_at,
  }));

  const quoteTakeEvents: QuoteTakeEvent[] = ((quoteTakeEventsResult.data || []) as QuoteTakeEventRow[]).map((row) => ({
    id: row.id,
    sourceWorkItemId: row.source_work_item_id,
    rotation: row.rotation,
    receivedAt: row.received_at,
    takenAt: row.taken_at,
    takerProfileId: row.taker_profile_id,
    takerName: nameByProfile.get(row.taker_profile_id) || "Unknown agent",
    takerUsername: usernameByProfile.get(row.taker_profile_id) || "unknown",
    skippedProfileIds: row.skipped_profile_ids || [],
    skippedAgents: (row.skipped_profile_ids || []).map((id) => ({
      id,
      name: nameByProfile.get(id) || "Unknown agent",
      username: usernameByProfile.get(id) || "unknown",
    })),
    elapsedSeconds: row.elapsed_seconds,
  }));

  const quoteTakeTimers: QuoteTakeTimer[] = ((quoteTakeTimersResult.data || []) as QuoteTakeTimerRow[]).map((row) => ({
    id: row.id,
    rotation: row.rotation,
    currentProfileId: row.current_profile_id,
    currentAgentName: nameByProfile.get(row.current_profile_id) || "Unknown agent",
    currentAgentUsername: usernameByProfile.get(row.current_profile_id) || "unknown",
    startedByProfileId: row.started_by_profile_id,
    startedByName: nameByProfile.get(row.started_by_profile_id) || "Unknown agent",
    startedByUsername: usernameByProfile.get(row.started_by_profile_id) || "unknown",
    receivedAt: row.received_at,
    deadlineAt: row.deadline_at,
    customer: row.customer_name,
    dealer: row.dealer_id ? dealerById.get(row.dealer_id) || "Unknown source" : "Direct / No source",
    workType: row.work_type,
    note: row.note || undefined,
    status: row.status,
    startedAt: row.started_at,
    warningSentAt: row.warning_sent_at || undefined,
  }));

  const settingsRow = settingsResult.data as WorkDeskSettingsRow | null;
  const settings: WorkDeskSettings = {
    customerServiceOverflowEnabled: settingsRow?.customer_service_overflow_enabled || false,
    customerServiceProfileId: settingsRow?.customer_service_profile_id || undefined,
    customerServiceProfileName: settingsRow?.customer_service_profile_id ? nameByProfile.get(settingsRow.customer_service_profile_id) : undefined,
    customerServiceProfileUsername: settingsRow?.customer_service_profile_id ? usernameByProfile.get(settingsRow.customer_service_profile_id) : undefined,
  };

  const notifications: AlertNotification[] = ((notificationsResult.data || []) as NotificationRow[]).map((row) => ({
    id: row.id,
    type: row.notification_type,
    title: row.title,
    message: row.message,
    entityType: row.entity_type || undefined,
    entityId: row.entity_id || undefined,
    createdAt: row.created_at,
    readAt: row.read_at || undefined,
  }));

  const passEvents: PassEvent[] = ((passEventsResult.data || []) as PassEventRow[]).map((row) => ({
    id: row.id,
    rotation: row.rotation,
    actorAgentId: row.actor_profile_id,
    actorAgent: nameByProfile.get(row.actor_profile_id) || "Unknown agent",
    createdAt: row.created_at,
    reason: row.reason || undefined,
  }));

  const performanceMap = new Map(((performanceResult.data || []) as PerformanceDbRow[]).map((row) => [row.profile_id, row]));
  const performance: PerformanceRow[] = agentProfiles.map((profile) => {
    const row = performanceMap.get(profile.id);
    return {
      agentId: profile.id,
      whatsappQuotes: row?.whatsapp_quotes || 0,
      ringCentralQuotes: row?.ringcentral_quotes || 0,
      workloadTurns: row?.workload_turns || 0,
      whatsappUpdates: row?.whatsapp_updates || 0,
      manualQuotes: row?.manual_quotes || 0,
      soldQuotes: row?.sold_quotes || 0,
      ownedActivations: row?.owned_activations || 0,
      ownedChanges: row?.owned_changes || 0,
      requotes: row?.requotes || 0,
      passedTurns: row?.passed_turns || 0,
    };
  });

  const rotations: Record<RotationKind, string | null> = { whatsapp: null, ringcentral: null, workload: null };
  for (const row of rotationsResult.data || []) {
    const kind = row.kind as RotationKind;
    rotations[kind] = row.current_profile_id || null;
  }

  return { agents, sources: sourceOptions, workItems, pendingPricing, quoteOutcomes, quoteNotes, quoteActivities, quoteTakeEvents, quoteTakeTimers, settings, notifications, performance, passEvents, rotations };
}
