/**
 * RingCentral SMS Service
 *
 * Server-only module for sending SMS via RingCentral's REST API.
 * Uses JWT authentication for persistent, non-expiring access.
 *
 * Environment variables required:
 *   RC_CLIENT_ID, RC_CLIENT_SECRET, RC_JWT_TOKEN, RC_SMS_FROM_NUMBER, RC_SERVER_URL
 */

import { SDK } from '@ringcentral/sdk';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

interface RcConfig {
  clientId: string;
  clientSecret: string;
  jwtToken: string;
  serverUrl: string;
  fromNumber: string;
}

function getConfig(): RcConfig {
  const clientId = process.env.RC_CLIENT_ID;
  const clientSecret = process.env.RC_CLIENT_SECRET;
  const jwtToken = process.env.RC_JWT_TOKEN;
  const serverUrl = process.env.RC_SERVER_URL || 'https://platform.ringcentral.com';
  const fromNumber = process.env.RC_SMS_FROM_NUMBER;

  if (!clientId || !clientSecret || !jwtToken || !fromNumber) {
    throw new Error(
      'RingCentral SMS is not configured. Set RC_CLIENT_ID, RC_CLIENT_SECRET, RC_JWT_TOKEN, and RC_SMS_FROM_NUMBER environment variables.',
    );
  }

  return { clientId, clientSecret, jwtToken, serverUrl, fromNumber };
}

export function isRingCentralConfigured(): boolean {
  return Boolean(
    process.env.RC_CLIENT_ID &&
      process.env.RC_CLIENT_SECRET &&
      process.env.RC_JWT_TOKEN &&
      process.env.RC_SMS_FROM_NUMBER,
  );
}

// ---------------------------------------------------------------------------
// SDK Singleton (reused across requests within the same server process)
// ---------------------------------------------------------------------------

let sdkInstance: InstanceType<typeof SDK> | null = null;

function getSdk(): InstanceType<typeof SDK> {
  if (!sdkInstance) {
    const config = getConfig();
    sdkInstance = new SDK({
      server: config.serverUrl,
      clientId: config.clientId,
      clientSecret: config.clientSecret,
    });
  }
  return sdkInstance;
}

async function ensureLoggedIn(): Promise<InstanceType<typeof SDK>> {
  const sdk = getSdk();
  const platform = sdk.platform();

  if (!await platform.loggedIn()) {
    const config = getConfig();
    await platform.login({ jwt: config.jwtToken });
  }

  return sdk;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SmsSendResult {
  success: boolean;
  messageId?: string;
  messageStatus?: string;
  error?: string;
}

export interface SmsBatchRecipient {
  to: string;
  text?: string;
}

export interface SmsBatchResult {
  success: boolean;
  batchId?: string;
  batchSize?: number;
  status?: string;
  rejected?: Array<{ index: number; to: string[]; errorCode: string; description: string }>;
  error?: string;
}

// ---------------------------------------------------------------------------
// Send a single SMS (P2P endpoint — good for manual agent sends)
// ---------------------------------------------------------------------------

export async function sendSms(to: string, text: string): Promise<SmsSendResult> {
  try {
    const sdk = await ensureLoggedIn();
    const platform = sdk.platform();
    const config = getConfig();

    const response = await platform.post('/restapi/v1.0/account/~/extension/~/sms', {
      from: { phoneNumber: config.fromNumber },
      to: [{ phoneNumber: normalizePhone(to) }],
      text,
    });

    const json = await response.json();

    return {
      success: true,
      messageId: json.id?.toString(),
      messageStatus: json.messageStatus,
    };
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : 'Unknown RingCentral error';
    return { success: false, error: message };
  }
}

// ---------------------------------------------------------------------------
// Send batch SMS (A2P endpoint — for automated scheduled reminders)
// ---------------------------------------------------------------------------

export async function sendBatchSms(
  recipients: SmsBatchRecipient[],
  defaultText?: string,
): Promise<SmsBatchResult> {
  if (recipients.length === 0) {
    return { success: true, batchId: undefined, batchSize: 0, status: 'Empty' };
  }

  try {
    const sdk = await ensureLoggedIn();
    const platform = sdk.platform();
    const config = getConfig();

    const body: Record<string, unknown> = {
      from: config.fromNumber,
      messages: recipients.map((r) => ({
        to: [normalizePhone(r.to)],
        ...(r.text ? { text: r.text } : {}),
      })),
    };

    if (defaultText) {
      body.text = defaultText;
    }

    const response = await platform.post('/restapi/v1.0/account/~/a2p-sms/batches', body);
    const json = await response.json();

    return {
      success: true,
      batchId: json.id,
      batchSize: json.batchSize,
      status: json.status,
      rejected: json.rejected || [],
    };
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : 'Unknown RingCentral batch error';
    return { success: false, error: message };
  }
}

// ---------------------------------------------------------------------------
// Check message delivery status
// ---------------------------------------------------------------------------

export async function getMessageStatus(messageId: string): Promise<string | null> {
  try {
    const sdk = await ensureLoggedIn();
    const platform = sdk.platform();
    const response = await platform.get(
      `/restapi/v1.0/account/~/extension/~/message-store/${messageId}`,
    );
    const json = await response.json();
    return json.messageStatus || null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Check batch status
// ---------------------------------------------------------------------------

export async function getBatchStatus(batchId: string): Promise<{ status: string; processedCount: number } | null> {
  try {
    const sdk = await ensureLoggedIn();
    const platform = sdk.platform();
    const response = await platform.get(`/restapi/v1.0/account/~/a2p-sms/batches/${batchId}`);
    const json = await response.json();
    return { status: json.status, processedCount: json.processedCount };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Renewal message templates
// ---------------------------------------------------------------------------

export type RenewalReminderTier = 'auto_30d' | 'auto_15d' | 'auto_7d';

export function buildRenewalReminderMessage(input: {
  customerName: string;
  carrier: string | null;
  policyNumber: string;
  renewalDate: string;
  officePhone?: string;
}): string {
  const firstName = input.customerName.split(/[\s,]+/)[0];
  const carrier = input.carrier || 'your insurance';
  const phone = input.officePhone || '(704) 879-3673';
  const dateFormatted = new Date(`${input.renewalDate}T00:00:00`).toLocaleDateString('en-US', {
    month: '2-digit',
    day: '2-digit',
    year: 'numeric',
  });

  return `Hi ${firstName}, your ${carrier} policy ${input.policyNumber} renews on ${dateFormatted}. Please call us at ${phone} if you'd like to review your options. Reply STOP to opt out. — New Hope Insurance`;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalizePhone(phone: string): string {
  // Strip everything except digits
  const digits = phone.replace(/\D/g, '');
  // If 10 digits, assume US and prepend +1
  if (digits.length === 10) return `+1${digits}`;
  // If 11 digits starting with 1, prepend +
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  // If already has +, return as-is
  if (phone.startsWith('+')) return phone;
  return `+${digits}`;
}
