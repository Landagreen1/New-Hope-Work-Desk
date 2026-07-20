// Commercial Quotes Board — TypeScript types

export type BoardColumn =
  | 'quote_intake'
  | 'quoting'
  | 'price_sent'
  | 'sold'
  | 'not_sold'
  | 'commission_approved'
  | 'commission_not_approved'
  | 'archive';

export type RiskLevel = 'low' | 'medium' | 'high';
export type CardStatus = 'in_progress' | 'done' | 'blocked' | 'waiting';
export type CoverageType =
  | 'gl'
  | 'wc'
  | 'umb'
  | 'gl_wc'
  | 'gl_wc_umb'
  | 'bop'
  | 'commercial_auto'
  | 'other';

export type CommissionStatus = 'pending' | 'approved' | 'denied';

export type ActivityEventType =
  | 'created'
  | 'column_moved'
  | 'field_updated'
  | 'comment_added'
  | 'attachment_uploaded'
  | 'attachment_deleted'
  | 'checklist_created'
  | 'checklist_item_added'
  | 'checklist_item_toggled'
  | 'checklist_item_deleted'
  | 'checklist_deleted'
  | 'commission_approved'
  | 'commission_denied'
  | 'card_deleted'
  | 'card_restored'
  | 'card_archived'
  | 'assigned_changed';

export interface CommercialQuoteProfile {
  display_name: string;
  initials: string;
  role: string;
}

export interface CommercialQuote {
  id: string;
  business_name: string;
  description: string | null;
  board_column: BoardColumn;
  column_position: number;
  risk_level: RiskLevel;
  card_status: CardStatus;
  policy_number: string | null;
  coverage_type: CoverageType | null;
  coverage_type_other: string | null;
  assigned_to: string;
  is_mirrored: boolean;
  column_entered_at: string;
  board_entered_at: string;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
  // Commission fields
  commission_status: CommissionStatus | null;
  commission_decision_by: string | null;
  commission_decision_at: string | null;
  commission_denial_reason: string | null;
  commission_notes: string | null;
  sold_premium: number | null;
  sold_at: string | null;
  // Soft delete
  is_deleted: boolean;
  deleted_at: string | null;
  deleted_by: string | null;
  deleted_reason: string | null;
  // Joined relations
  profiles?: CommercialQuoteProfile;
  commercial_quote_comments?: Array<{ count: number }> | { count: number }[];
  commercial_quote_attachments?: Array<{ count: number }> | { count: number }[];
  commercial_quote_checklists?: Array<{
    id: string;
    commercial_quote_checklist_items: Array<{ id: string; is_checked: boolean }>;
  }>;
}

export interface CommercialComment {
  id: string;
  quote_id?: string;
  content: string;
  author_id: string;
  created_at: string;
  updated_at: string;
  profiles?: { display_name: string; initials: string };
}

export interface CommercialAttachment {
  id: string;
  file_name: string;
  file_size: number;
  mime_type: string;
  storage_path: string;
  created_at: string;
  profiles?: { display_name: string };
}

export interface ChecklistItem {
  id: string;
  label: string;
  is_checked: boolean;
  position: number;
}

export interface Checklist {
  id: string;
  title: string;
  position: number;
  created_at?: string;
  commercial_quote_checklist_items: ChecklistItem[];
}

export interface ColumnHistory {
  id: string;
  from_column: string | null;
  to_column: string;
  moved_at: string;
  profiles?: { display_name: string };
}

export const BOARD_COLUMNS: { id: BoardColumn; label: string; color: string }[] = [
  { id: 'quote_intake', label: 'Quote Intake', color: 'bg-blue-500' },
  { id: 'quoting', label: 'Quoting', color: 'bg-amber-500' },
  { id: 'price_sent', label: 'Price Sent', color: 'bg-violet-500' },
  { id: 'sold', label: 'Sold', color: 'bg-emerald-500' },
  { id: 'not_sold', label: 'Not Sold', color: 'bg-rose-500' },
  { id: 'commission_approved', label: 'Commission Approved', color: 'bg-green-600' },
  { id: 'commission_not_approved', label: 'Commission Not Approved', color: 'bg-orange-500' },
  { id: 'archive', label: 'Archive', color: 'bg-gray-400' },
];

// Agent-allowed transitions: agents can move cards through these columns
export const AGENT_ALLOWED_COLUMNS: BoardColumn[] = [
  'quote_intake', 'quoting', 'price_sent', 'sold', 'not_sold',
];

// Manager-only columns: only managers can move cards here
export const MANAGER_ONLY_COLUMNS: BoardColumn[] = [
  'commission_approved', 'commission_not_approved', 'archive',
];

// Columns where cards are locked (view-only for agents)
export const LOCKED_COLUMNS: BoardColumn[] = [
  'commission_approved', 'commission_not_approved', 'archive',
];

export const RISK_STYLES: Record<RiskLevel, { bg: string; text: string; label: string }> = {
  low: { bg: 'bg-green-100', text: 'text-green-800', label: 'Low' },
  medium: { bg: 'bg-amber-100', text: 'text-amber-800', label: 'Medium' },
  high: { bg: 'bg-rose-100', text: 'text-rose-800', label: 'High' },
};

export const STATUS_STYLES: Record<CardStatus, { bg: string; text: string; label: string }> = {
  in_progress: { bg: 'bg-blue-100', text: 'text-blue-800', label: 'In Progress' },
  done: { bg: 'bg-emerald-100', text: 'text-emerald-800', label: 'Done' },
  blocked: { bg: 'bg-rose-100', text: 'text-rose-800', label: 'Blocked' },
  waiting: { bg: 'bg-amber-100', text: 'text-amber-800', label: 'Waiting' },
};

export const COVERAGE_LABELS: Record<CoverageType, string> = {
  gl: 'GL',
  wc: 'WC',
  umb: 'UMB',
  gl_wc: 'GL + WC',
  gl_wc_umb: 'GL + WC + UMB',
  bop: 'BOP',
  commercial_auto: 'Commercial Auto',
  other: 'Other',
};

export interface ActivityLogEntry {
  id: string;
  quote_id: string;
  actor_id: string;
  event_type: ActivityEventType;
  details: Record<string, unknown> | null;
  created_at: string;
  profiles?: { display_name: string; initials: string };
}

export const ACTIVITY_EVENT_LABELS: Record<ActivityEventType, string> = {
  created: 'Card Created',
  column_moved: 'Moved to Column',
  field_updated: 'Field Updated',
  comment_added: 'Comment Added',
  attachment_uploaded: 'File Uploaded',
  attachment_deleted: 'File Deleted',
  checklist_created: 'Checklist Created',
  checklist_item_added: 'Checklist Item Added',
  checklist_item_toggled: 'Checklist Item Toggled',
  checklist_item_deleted: 'Checklist Item Deleted',
  checklist_deleted: 'Checklist Deleted',
  commission_approved: 'Commission Approved',
  commission_denied: 'Commission Denied',
  card_deleted: 'Card Deleted',
  card_restored: 'Card Restored',
  card_archived: 'Card Archived',
  assigned_changed: 'Assignment Changed',
};

export const COMMISSION_STATUS_STYLES: Record<string, { bg: string; text: string; label: string }> = {
  pending: { bg: 'bg-amber-100', text: 'text-amber-800', label: 'Pending Review' },
  approved: { bg: 'bg-emerald-100', text: 'text-emerald-800', label: 'Approved' },
  denied: { bg: 'bg-rose-100', text: 'text-rose-800', label: 'Denied' },
};
