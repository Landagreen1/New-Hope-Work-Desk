// src/lib/format-date.ts
// App-wide date formatting utility.
// All user-facing dates use MM/DD/YYYY. All user-facing date-times use MM/DD/YYYY h:mm AM/PM.

const EM_DASH = '\u2014';

/**
 * Format a date value as MM/DD/YYYY.
 *
 * Accepts ISO strings, Date objects, or YYYY-MM-DD calendar dates.
 * Returns an em dash when the value is absent or unparseable.
 */
export function formatDateDisplay(value: string | Date | null | undefined): string {
  if (value === null || value === undefined) return EM_DASH;
  const date = value instanceof Date ? value : new Date(
    // A bare YYYY-MM-DD string parsed with `new Date()` is treated as UTC midnight,
    // which can roll back a day in western timezones. Appending T00:00:00 forces local.
    /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00` : value,
  );
  if (Number.isNaN(date.getTime())) return EM_DASH;
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const year = date.getFullYear();
  return `${month}/${day}/${year}`;
}

/**
 * Format a date-time value as MM/DD/YYYY h:mm AM/PM.
 *
 * Accepts ISO strings or Date objects.
 * Returns an em dash when the value is absent or unparseable.
 */
export function formatDateTimeDisplay(value: string | Date | null | undefined): string {
  if (value === null || value === undefined) return EM_DASH;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return EM_DASH;
  const datePart = formatDateDisplay(date);
  const hours = date.getHours();
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const ampm = hours >= 12 ? 'PM' : 'AM';
  const hour12 = hours % 12 || 12;
  return `${datePart} ${hour12}:${minutes} ${ampm}`;
}

/**
 * Format a date-time value in a specific timezone as MM/DD/YYYY h:mm AM/PM.
 *
 * Uses Intl.DateTimeFormat to convert to the target timezone before formatting.
 */
export function formatDateTimeInZone(
  value: string | Date | null | undefined,
  timeZone: string,
): string {
  if (value === null || value === undefined) return EM_DASH;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return EM_DASH;

  // Use Intl to get timezone-converted parts
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).formatToParts(date);

  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  const month = get('month');
  const day = get('day');
  const year = get('year');
  const hour = get('hour');
  const minute = get('minute');
  const dayPeriod = get('dayPeriod');

  return `${month}/${day}/${year} ${hour}:${minute} ${dayPeriod}`;
}

/**
 * Format a date value in a specific timezone as MM/DD/YYYY.
 */
export function formatDateInZone(
  value: string | Date | null | undefined,
  timeZone: string,
): string {
  if (value === null || value === undefined) return EM_DASH;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return EM_DASH;

  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);

  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('month')}/${get('day')}/${get('year')}`;
}
