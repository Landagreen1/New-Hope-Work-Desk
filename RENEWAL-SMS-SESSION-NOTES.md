# Renewal SMS via RingCentral — Session Notes

**Date:** July 20, 2026
**Branch:** `feature/renewal-sms-ringcentral`

---

## Summary of Decisions

### What We're Building
Automated SMS renewal reminders sent to insureds after the Power BI renewal file is uploaded. Two touchpoints: 30 days and 25 days before renewal date.

### Phone Number Strategy
- **Send FROM:** (704) 879-3673 — dedicated texting line (protects main number from spam flagging)
- **Message says "call us at":** (704) 824-3130 — main office number
- This two-number approach keeps the main office number clean with carriers

### Default Message Templates

**30-day touchpoint:**
> Hi {first_name}, this is New Hope Insurance. Your {carrier} policy is coming up for renewal on {date}. Give us a call at (704) 824-3130 to go over your renewal pricing and options. We're here to help! Reply STOP to opt out.

**25-day touchpoint:**
> Hi {first_name}, just a friendly reminder from New Hope Insurance — your {carrier} policy renews on {date}. Call us at (704) 824-3130 so we can review your renewal rate. We want to make sure you have the best coverage at the best price!

### Trigger
- Automatic after Power BI CSV import
- System scans for records 29-31 days out (touchpoint 30) and 24-26 days out (touchpoint 25)
- Idempotent — won't double-send for same touchpoint

### Short Codes Decision
- NOT using a short code ($500-1500/month, 8-12 week setup)
- Using 10-digit number (10DLC) which is right for our volume
- NEED to register 10DLC in RingCentral Admin Portal → Messaging → Business SMS Registration

---

## What Byron Needs to Do (RingCentral Setup)

### Step 1: Create the App
1. Go to https://developers.ringcentral.com → Console
2. Create REST API App → JWT auth flow (Server-only, No UI)
3. Permissions: SMS (Read/Send) + Webhook Subscriptions
4. Copy **Client ID** and **Client Secret**

### Step 2: Generate JWT Token
1. Developer Console → Profile → Credentials → JWT Credentials
2. Generate token, copy it (shown only once)

### Step 3: Confirm SMS on (704) 879-3673
1. Go to https://service.ringcentral.com (Admin Portal)
2. Phone System → Phone Numbers → find (704) 879-3673
3. Confirm SMS feature is enabled on that number

### Step 4: Register 10DLC (prevents carrier filtering)
1. Admin Portal → Messaging → Business SMS Registration
2. Register brand: "New Hope Insurance"
3. Campaign type: "Insurance renewal reminders"
4. Takes 1-3 business days to approve

### Values Needed for .env.local
```
RINGCENTRAL_SERVER_URL=https://platform.devtest.ringcentral.com
RINGCENTRAL_CLIENT_ID=<from step 1>
RINGCENTRAL_CLIENT_SECRET=<from step 1>
RINGCENTRAL_JWT_TOKEN=<from step 2>
RINGCENTRAL_SMS_FROM_NUMBER=+17048793673
RINGCENTRAL_OFFICE_PHONE=+17048243130
```

---

## Spec Files Created
- `.kiro/specs/renewal-sms-ringcentral/requirements.md` — Full requirements (8 requirement groups)
- `.kiro/specs/renewal-sms-ringcentral/design.md` — Architecture, DB schema, API routes, data flows
- `.kiro/specs/renewal-sms-ringcentral/tasks.md` — 6 task groups, 20+ subtasks, ordered bottom-up

---

## Next Steps (When Credentials Are Ready)
1. Start Task 1: Database migration (new tables + columns)
2. Task 2: RingCentral server library (auth, send, templates)
3. Task 3: API routes (sms-scan, webhook, health)
4. Task 4: Hook into import flow
5. Task 5: UI components (delivery history, status indicators, dashboard)
6. Task 6: Sandbox testing end-to-end

---

## To Continue on Another Device
1. `git pull origin feature/renewal-sms-ringcentral`
2. Open the workspace in Kiro
3. Reference this file or the spec at `.kiro/specs/renewal-sms-ringcentral/`
4. Tell Kiro: "Continue with the renewal SMS spec — I have my RC credentials ready" (or whatever step you're at)
