# Requirements Document

## Introduction

This specification defines the automated SMS notification system for policy renewals using the RingCentral SMS API. After a renewal import (Power BI CSV upload), the system automatically identifies policies within the notification window and sends professional SMS reminders to insureds prompting them to call New Hope Insurance for their renewal pricing.

Messages are sent at two touchpoints: 30 days before renewal and 25 days before renewal. The system uses RingCentral's REST API for outbound SMS and webhook-based inbound reply handling.

The platform is Next.js 16 with React 19, Supabase (database and auth), TypeScript, and Tailwind CSS 4.

**Phone strategy:** SMS messages are sent FROM (704) 879-3673 (a dedicated texting line) to protect the main office number from spam flagging. The message body instructs customers to call the main office at (704) 824-3130.

## Glossary

- **Renewal_Record**: An imported policy renewal row in `renewal_records` with customer name, phone, renewal date, carrier, and policy number.
- **SMS_Notification**: An outbound text message sent to an insured's phone number via RingCentral.
- **Notification_Window**: The range of days before a renewal date during which SMS messages are eligible to be sent (30 days and 25 days).
- **Touchpoint**: A specific day-threshold at which a message is sent (touchpoint_30 = 30 days before renewal, touchpoint_25 = 25 days before renewal).
- **Opt_Out**: A customer who has replied STOP or otherwise indicated they do not wish to receive SMS. The system must honor this permanently.
- **Delivery_Record**: A database row tracking each SMS sent, its RingCentral message ID, delivery status, and timestamp.
- **Import_Trigger**: The event that fires after a successful renewal batch import, initiating the SMS eligibility scan.
- **RC_Webhook**: A RingCentral webhook subscription that notifies the app when inbound SMS replies arrive.

## Requirements

### Requirement 1: Automatic SMS Trigger After Import

**User Story:** As a Manager, I want renewal SMS notifications to be sent automatically after I upload the Power BI renewal file, so that customers are reminded without any manual intervention.

#### Acceptance Criteria

1. WHEN a renewal import batch completes successfully, THE system SHALL scan all open renewal records for SMS eligibility.
2. THE system SHALL identify records where `renewal_date` minus today equals exactly 30 days OR exactly 25 days (±1 day tolerance to account for import timing).
3. THE system SHALL NOT send an SMS to a renewal record that has already received a message for that same touchpoint (idempotency).
4. THE system SHALL NOT send an SMS to a renewal record with status `renewed`, `lost`, or `cancelled`.
5. THE system SHALL NOT send an SMS to a renewal record where `customer_phone` is NULL or empty.
6. THE system SHALL NOT send an SMS to a customer who has opted out.
7. WHEN the scan completes, THE system SHALL return a summary count: messages_sent, messages_skipped (already sent), messages_ineligible (no phone/opted out/closed).

### Requirement 2: Message Content

**User Story:** As an insured, I want to receive a clear, professional message identifying the agency and prompting me to call, so that I know the context immediately.

#### Acceptance Criteria

1. THE 30-day message SHALL read:
   > "Hi {customer_first_name}, this is New Hope Insurance. Your {carrier} policy is coming up for renewal on {renewal_date_formatted}. Give us a call at (704) 824-3130 to go over your renewal pricing and options. We're here to help!"

2. THE 25-day message SHALL read:
   > "Hi {customer_first_name}, just a friendly reminder from New Hope Insurance — your {carrier} policy renews on {renewal_date_formatted}. Call us at (704) 824-3130 so we can review your renewal rate. We want to make sure you have the best coverage at the best price!"

3. `{customer_first_name}` SHALL be derived by taking the first word of `customer_name`.
4. `{renewal_date_formatted}` SHALL be formatted as "Month Day" (e.g., "August 15").
5. `{carrier}` SHALL use the `carrier` field from the renewal record; IF null, the message SHALL omit the carrier reference and say "your auto policy" instead.
6. THE system SHALL store message templates in the database so they can be edited by a Manager without code deployment.

### Requirement 3: RingCentral Integration

**User Story:** As a Developer, I want a secure, authenticated connection to RingCentral's SMS API, so that messages are sent reliably from the business number.

#### Acceptance Criteria

1. THE system SHALL authenticate with RingCentral using JWT (server-to-server) credentials stored as server-only environment variables.
2. THE system SHALL send SMS via the RingCentral `/restapi/v1.0/account/~/extension/~/sms` endpoint.
3. THE `from` number SHALL be the dedicated SMS line: +17048793673. This is separate from the main office number to avoid spam flagging on the primary business line.
4. THE system SHALL format all recipient phone numbers to E.164 before sending (+1 prefix for US numbers).
5. IF RingCentral returns a rate-limit (429) or transient error (5xx), THE system SHALL retry up to 3 times with exponential backoff (1s, 3s, 9s).
6. IF RingCentral returns a permanent error (4xx other than 429), THE system SHALL log the failure in the delivery record and skip that message.
7. THE system SHALL register a webhook subscription for inbound SMS to the dedicated texting line (+17048793673) so replies can be captured.

### Requirement 4: Delivery Tracking

**User Story:** As a Manager, I want to see which customers received SMS and their delivery status, so that I can monitor outreach effectiveness.

#### Acceptance Criteria

1. THE system SHALL create a `renewal_sms_deliveries` table recording: renewal_record_id, touchpoint (30 or 25), rc_message_id, sent_at, delivery_status (queued, sent, delivered, failed), message_body, recipient_phone, error_detail.
2. WHEN an SMS is sent successfully, THE system SHALL insert a delivery record with status `sent`.
3. IF a delivery status callback is received from RingCentral, THE system SHALL update the delivery record status accordingly.
4. THE system SHALL log each outbound SMS as a `renewal_contact` entry with channel='sms', direction='outbound', entry_source='ringcentral_api', linking the rc_message_id.
5. THE Renewals page renewal drawer SHALL display SMS delivery history alongside manual contacts.

### Requirement 5: Opt-Out / Compliance

**User Story:** As an insured, I want to reply STOP to unsubscribe from future messages, so that I can control communications.

#### Acceptance Criteria

1. WHEN an inbound SMS containing "STOP", "UNSUBSCRIBE", "CANCEL", or "OPT OUT" (case-insensitive) is received, THE system SHALL mark that phone number as opted-out in a `renewal_sms_optouts` table.
2. THE system SHALL immediately cease all future SMS to that phone number across all renewal records.
3. WHEN an inbound SMS containing "START" or "OPT IN" (case-insensitive) is received, THE system SHALL remove the opt-out record for that phone number.
4. THE system SHALL include standard TCPA-compliant language: every first message to a new number SHALL append "Reply STOP to opt out." to the message body.
5. THE system SHALL track whether a number has previously received a first-contact message to avoid repeating the opt-out footer on subsequent touchpoints.

### Requirement 6: Inbound Reply Handling

**User Story:** As an Agent, I want to see customer replies in the renewal timeline, so that I can follow up on responses.

#### Acceptance Criteria

1. WHEN an inbound SMS is received on the business number via webhook, THE system SHALL match the sender phone to a renewal record by `customer_phone`.
2. IF matched, THE system SHALL insert a `renewal_contact` entry with channel='sms', direction='inbound', entry_source='ringcentral_api', and the message body as `notes`.
3. IF no renewal record matches, THE system SHALL log the inbound message to a `renewal_sms_unmatched` table for manual review.
4. THE system SHALL NOT auto-reply to inbound messages (except the system-level STOP confirmation handled by RingCentral).

### Requirement 7: Environment & Configuration

**User Story:** As a Developer, I want all RingCentral credentials and configuration stored securely, so that secrets are never exposed to the client.

#### Acceptance Criteria

1. THE following environment variables SHALL be required (server-only, never prefixed with NEXT_PUBLIC):
   - `RINGCENTRAL_SERVER_URL` (sandbox or production)
   - `RINGCENTRAL_CLIENT_ID`
   - `RINGCENTRAL_CLIENT_SECRET`
   - `RINGCENTRAL_JWT_TOKEN`
   - `RINGCENTRAL_SMS_FROM_NUMBER` (default: +17048793673 — dedicated texting line)
   - `RINGCENTRAL_OFFICE_PHONE` (default: +17048243130 — used in message body)
2. THE system SHALL provide a health-check API route (`/api/ringcentral/health`) that verifies authentication without exposing credentials.
3. THE system SHALL work in sandbox mode during development (configurable via `RINGCENTRAL_SERVER_URL`).

### Requirement 8: Manager Visibility & Controls

**User Story:** As a Manager, I want an SMS dashboard in the renewals module showing send history and the ability to manually trigger or skip SMS for specific records.

#### Acceptance Criteria

1. THE Renewals page SHALL include an "SMS" tab or section showing: total sent today, delivery success rate, opt-outs count, and recent failures.
2. A Manager SHALL be able to manually trigger an SMS send for any eligible renewal record (override the day-window check).
3. A Manager SHALL be able to mark a specific renewal record as "SMS skip" to prevent all automated messages for that record.
4. THE system SHALL display the SMS status per renewal record in the list view (sent/pending/skipped/opted-out).
