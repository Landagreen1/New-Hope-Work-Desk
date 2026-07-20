/**
 * Database roles — kept as-is for Supabase auth compatibility.
 * Logical department mapping:
 *   'agent'            → Sales department
 *   'manager'          → Management department
 *   'customer_service' → Customer Service department
 *
 * Cross-cutting tools available to ALL departments:
 *   - Customer Quote intake forms
 *   - Intake Queue (sales handoff from CS)
 *   - Renewals
 */
export type AppRole = "agent" | "manager" | "customer_service" | "commercial";
export type AvailabilityStatus = "available" | "break" | "unavailable";
export type RotationKind = "whatsapp" | "ringcentral" | "workload";
export type WorkType =
  | "new_quote"
  | "requote"
  | "activation"
  | "change"
  | "whatsapp_update"
  | "payment";
export type AssignmentMethod =
  | "whatsapp_turn"
  | "ringcentral_turn"
  | "workload_turn"
  | "owner"
  | "update_log"
  | "manager_manual"
  | "manual_quote"
  | "manual_workload"
  | "payment_log"
  | "customer_service";
export type WorkStatus = "active" | "completed" | "cancelled";
export type QuoteDecision = "sold" | "not_sold";
export type NotSoldReason =
  | "price_too_high"
  | "chose_another_option"
  | "no_response"
  | "no_longer_needed"
  | "other";
export type NotificationType = "turn" | "assignment";

export interface SessionProfile {
  id: string;
  username: string;
  displayName: string;
  initials: string;
  role: AppRole;
  mustChangePassword: boolean;
}

export interface SourceOption {
  id: string;
  name: string;
}

export interface DealerSalesperson {
  id: string;
  dealerId: string;
  name: string;
  notes?: string;
  isActive: boolean;
  createdAt: string;
}

export interface Agent {
  id: string;
  name: string;
  initials: string;
  rotationPosition: number;
  whatsappPosition: number;
  ringCentralPosition: number;
  workloadPosition: number;
  availability: AvailabilityStatus;
  whatsappActive: boolean;
  ringCentralActive: boolean;
  workloadActive: boolean;
  activeCount: number;
}

export interface WorkItem {
  id: string;
  assignedProfileId: string;
  createdAt: string;
  assignedAt: string;
  acceptedAt?: string;
  customer: string;
  dealer: string;
  salespersonId?: string;
  salesperson?: string;
  workType: WorkType;
  originalOwner?: string;
  assignedAgent: string;
  assignmentMethod: AssignmentMethod;
  status: WorkStatus;
  changeType?: string;
  note?: string;
  receivedThrough?: string;
  completedAt?: string;
  relatedQuoteSourceWorkItemId?: string;
}

export interface PendingPricingItem {
  id: string;
  assignedProfileId: string;
  sourceWorkItemId: string;
  quoteCreatedAt: string;
  assignedAt: string;
  acceptedAt: string;
  priceSentAt: string;
  customer: string;
  dealer: string;
  salespersonId?: string;
  salesperson?: string;
  workType: "new_quote" | "requote";
  originalOwner?: string;
  assignedAgent: string;
  assignmentMethod: AssignmentMethod;
  receivedThrough?: string;
  note?: string;
}

export interface QuoteOutcome {
  id: string;
  assignedProfileId: string;
  sourceWorkItemId: string;
  quoteCreatedAt: string;
  assignedAt: string;
  acceptedAt: string;
  priceSentAt?: string;
  finalizedAt: string;
  customer: string;
  dealer: string;
  salespersonId?: string;
  salesperson?: string;
  workType: "new_quote" | "requote";
  originalOwner?: string;
  assignedAgent: string;
  assignmentMethod: AssignmentMethod;
  receivedThrough?: string;
  decision: QuoteDecision;
  notSoldReason?: NotSoldReason;
  notSoldReasonOther?: string;
}

export interface QuoteNote {
  id: string;
  sourceWorkItemId: string;
  authorProfileId: string;
  authorName: string;
  authorUsername: string;
  note: string;
  createdAt: string;
}

export interface QuoteActivity {
  id: string;
  sourceWorkItemId: string;
  eventType: string;
  actorProfileId?: string;
  actorName: string;
  actorUsername: string;
  assignedAgent?: string;
  details?: Record<string, unknown>;
  createdAt: string;
}

export interface QuoteTakeEvent {
  id: string;
  sourceWorkItemId: string;
  rotation: "whatsapp" | "ringcentral";
  receivedAt: string;
  takenAt: string;
  takerProfileId: string;
  takerName: string;
  takerUsername: string;
  skippedProfileIds: string[];
  skippedAgents: Array<{ id: string; name: string; username: string }>;
  elapsedSeconds: number;
}

export interface QuoteTakeTimer {
  id: string;
  rotation: "whatsapp" | "ringcentral";
  currentProfileId: string;
  currentAgentName: string;
  currentAgentUsername: string;
  startedByProfileId: string;
  startedByName: string;
  startedByUsername: string;
  receivedAt: string;
  deadlineAt: string;
  customer: string;
  dealer: string;
  salespersonId?: string;
  salesperson?: string;
  workType: "new_quote" | "requote";
  note?: string;
  status: "active" | "claimed" | "stolen" | "cancelled";
  startedAt: string;
  warningSentAt?: string;
}

export interface CustomerServiceUser {
  id: string;
  username: string;
  name: string;
  initials: string;
  activeCount: number;
}

export interface WorkDeskSettings {
  customerServiceOverflowEnabled: boolean;
  customerServiceProfileId?: string;
  customerServiceProfileName?: string;
  customerServiceProfileUsername?: string;
}

export interface AlertNotification {
  id: string;
  type: NotificationType;
  title: string;
  message: string;
  entityType?: string;
  entityId?: string;
  createdAt: string;
  readAt?: string;
}

export interface PassEvent {
  id: string;
  rotation: RotationKind;
  actorAgentId: string;
  actorAgent: string;
  createdAt: string;
  reason?: string;
}

export interface PerformanceRow {
  agentId: string;
  whatsappQuotes: number;
  ringCentralQuotes: number;
  workloadTurns: number;
  whatsappUpdates: number;
  manualQuotes: number;
  soldQuotes: number;
  ownedActivations: number;
  ownedChanges: number;
  requotes: number;
  passedTurns: number;
}

export interface DashboardData {
  agents: Agent[];
  customerServiceUsers: CustomerServiceUser[];
  sources: SourceOption[];
  salespeople: DealerSalesperson[];
  workItems: WorkItem[];
  pendingPricing: PendingPricingItem[];
  quoteOutcomes: QuoteOutcome[];
  quoteNotes: QuoteNote[];
  quoteActivities: QuoteActivity[];
  quoteTakeEvents: QuoteTakeEvent[];
  quoteTakeTimers: QuoteTakeTimer[];
  settings: WorkDeskSettings;
  notifications: AlertNotification[];
  performance: PerformanceRow[];
  passEvents: PassEvent[];
  rotations: Record<RotationKind, string | null>;
}
