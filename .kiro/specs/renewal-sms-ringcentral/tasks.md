# Implementation Plan: Renewal SMS via RingCentral

## Overview

This plan implements automated SMS notifications for policy renewals using RingCentral's REST API. After a renewal CSV import, the system scans eligible records at 30-day and 25-day marks and sends professional reminder messages. The implementation follows bottom-up order: database schema first, then server-side integration, API routes, and finally UI components.

## Tasks

- [ ] 1. Database schema migration
  - [ ] 1.1 Create `renewal_sms_templates` table
    - Table with id, touchpoint, template_body, is_active, created_by, timestamps
    - Unique partial index: one active template per touchpoint
    - Seed default templates for touchpoint_30 and touchpoint_25
    - _Requirements: 2.1, 2.2, 2.6_

  - [ ] 1.2 Create `renewal_sms_deliveries` table
    - Table with id, record_id (FK), touchpoint, rc_message_id, recipient_phone, message_body, delivery_status, error_detail, sent_at, status_updated_at
    - Unique constraint on (record_id, touchpoint) for idempotency
    - Index on (record_id), index on (sent_at DESC) for dashboard queries
    - _Requirements: 4.1, 4.2, 4.3, 1.3_

  - [ ] 1.3 Create `renewal_sms_optouts` table
    - Table with id, phone_number (unique), opted_out_at, opted_in_at, is_opted_out
    - Index on phone_number for fast lookup during eligibility scan
    - _Requirements: 5.1, 5.2, 5.3_

  - [ ] 1.4 Create `renewal_sms_unmatched` table
    - Table with id, from_number, message_body, received_at, rc_message_id
    - For inbound messages that don't match any renewal record
    - _Requirements: 6.3_

  - [ ] 1.5 Add columns to `renewal_records`
    - Add `sms_skip` boolean DEFAULT false
    - Add `sms_first_contact_sent` boolean DEFAULT false
    - _Requirements: 5.4, 8.3_

  - [ ] 1.6 RLS policies for all new tables
    - renewal_sms_templates: manager can SELECT/INSERT/UPDATE; agents can SELECT
    - renewal_sms_deliveries: manager and assigned agent can SELECT; system INSERT only (via service role)
    - renewal_sms_optouts: manager SELECT; system INSERT/UPDATE
    - renewal_sms_unmatched: manager SELECT
    - _Requirements: 7.1, 8.1_

- [ ] 2. RingCentral server library
  - [ ] 2.1 Create `src/lib/ringcentral.ts` — RC authentication module
    - JWT-based token acquisition and caching
    - Auto-refresh on 401
    - Token stored in module-level variable (server-only, no client import)
    - Environment variable validation on first use
    - _Requirements: 3.1, 3.2, 7.1, 7.3_

  - [ ] 2.2 Create `src/lib/ringcentral-sms.ts` — SMS send function
    - `sendSms(to: string, text: string)` function
    - E.164 phone normalization utility (`toE164`)
    - Retry logic: 3 retries with exponential backoff for 429/5xx
    - Permanent failure detection for other 4xx
    - _Requirements: 3.2, 3.3, 3.4, 3.5, 3.6_

  - [ ] 2.3 Create `src/lib/ringcentral-templates.ts` — Template rendering
    - `renderTemplate(template, record)` function
    - Placeholder substitution: {customer_first_name}, {renewal_date_formatted}, {carrier}
    - Fallback logic when carrier is null
    - First-contact STOP footer appending logic
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 5.4, 5.5_

- [ ] 3. API routes
  - [ ] 3.1 Create `POST /api/renewals/sms-scan` route
    - Auth check: manager role only
    - Query eligible records (open status, has phone, not opted-out, not skipped, not already sent for touchpoint, within day window)
    - Loop: render template → send SMS → insert delivery record → insert renewal_contact
    - Rate limit: max 50 per invocation
    - Return summary JSON: messages_sent, messages_skipped, messages_ineligible
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 4.4_

  - [ ] 3.2 Create `POST /api/ringcentral/webhook` route
    - Handle RC subscription validation (return validationToken)
    - Parse inbound SMS events
    - Check opt-out keywords (STOP, UNSUBSCRIBE, CANCEL, OPT OUT) → insert optout
    - Check opt-in keywords (START, OPT IN) → remove optout
    - Match sender phone to renewal_record → insert renewal_contact
    - Unmatched → insert to renewal_sms_unmatched
    - _Requirements: 5.1, 5.3, 6.1, 6.2, 6.3, 6.4_

  - [ ] 3.3 Create `GET /api/ringcentral/health` route
    - Auth check: manager role only
    - Attempt RC token refresh
    - Return status JSON
    - _Requirements: 7.2_

  - [ ] 3.4 Create `POST /api/renewals/sms-send-manual` route
    - Auth check: manager role only
    - Accept: { record_id, touchpoint }
    - Override day-window check, send SMS for specific record
    - _Requirements: 8.2_

  - [ ] 3.5 Create `PATCH /api/renewals/[id]/sms-skip` route
    - Auth check: manager role only
    - Toggle sms_skip on a renewal record
    - _Requirements: 8.3_

- [ ] 4. Import flow integration
  - [ ] 4.1 Add SMS scan trigger after successful import
    - After `importBatch()` resolves in the UI, call `/api/renewals/sms-scan`
    - Display result toast with send counts
    - Handle errors gracefully (import succeeds even if SMS fails)
    - _Requirements: 1.1, 1.7_

- [ ] 5. UI components
  - [ ] 5.1 SMS delivery history in Renewal Drawer
    - Query renewal_sms_deliveries for the open record
    - Show timeline entries: date, status badge (sent/delivered/failed), message preview
    - Interleave with existing renewal_contacts timeline
    - _Requirements: 4.5_

  - [ ] 5.2 SMS status indicator in renewal list rows
    - Show icon per row: ✉️ sent, ⏳ pending, ⛔ skipped, 🚫 opted-out
    - Derive from deliveries + optouts + sms_skip flag
    - _Requirements: 8.4_

  - [ ] 5.3 Manager SMS dashboard section
    - Add "SMS" tab/section to manager renewals view
    - Show: total sent today, delivery success rate, opt-outs count, recent failures
    - Manual send button per eligible record
    - Manual skip toggle per record
    - _Requirements: 8.1, 8.2, 8.3_

  - [ ] 5.4 Template editor modal
    - Manager-only modal to view/edit active templates per touchpoint
    - Preview rendered message with sample data
    - Save updates template, deactivate old one
    - _Requirements: 2.6_

- [ ] 6. Environment & deployment configuration
  - [ ] 6.1 Update `.env.example` with RingCentral variables
    - RINGCENTRAL_SERVER_URL, RINGCENTRAL_CLIENT_ID, RINGCENTRAL_CLIENT_SECRET, RINGCENTRAL_JWT_TOKEN, RINGCENTRAL_SMS_FROM_NUMBER (+17048793673), RINGCENTRAL_OFFICE_PHONE (+17048243130)
    - _Requirements: 7.1_

  - [ ] 6.2 Register RingCentral webhook subscription
    - Document the one-time webhook registration process
    - Create a setup script or API route for initial subscription
    - _Requirements: 3.7_

  - [ ] 6.3 Sandbox testing
    - Test full flow against RC sandbox: send, receive, opt-out
    - Verify idempotency (re-running scan doesn't double-send)
    - Verify phone normalization edge cases
    - _Requirements: 7.3_
