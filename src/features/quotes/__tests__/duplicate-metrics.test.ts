// src/features/quotes/__tests__/duplicate-metrics.test.ts
// Unit tests for duplicate rate metrics utility functions
// Validates: Requirements 16.5, 16.6

import { describe, it, expect } from 'vitest';
import { isOverdue, hoursSinceFlagged, validateDateRange } from '../duplicate-metrics';

describe('isOverdue', () => {
  it('returns true when flagged more than 72 hours ago', () => {
    const hoursAgo73 = new Date(Date.now() - 73 * 3_600_000).toISOString();
    expect(isOverdue(hoursAgo73)).toBe(true);
  });

  it('returns false when flagged less than 72 hours ago', () => {
    const hoursAgo71 = new Date(Date.now() - 71 * 3_600_000).toISOString();
    expect(isOverdue(hoursAgo71)).toBe(false);
  });

  it('returns false when flagged exactly 72 hours ago', () => {
    const hoursAgo72 = new Date(Date.now() - 72 * 3_600_000).toISOString();
    expect(isOverdue(hoursAgo72)).toBe(false);
  });

  it('returns false for a recently flagged item', () => {
    const now = new Date().toISOString();
    expect(isOverdue(now)).toBe(false);
  });

  it('returns true for a very old flagged item', () => {
    const daysAgo30 = new Date(Date.now() - 30 * 24 * 3_600_000).toISOString();
    expect(isOverdue(daysAgo30)).toBe(true);
  });
});

describe('hoursSinceFlagged', () => {
  it('returns approximately 0 for just-now timestamp', () => {
    const now = new Date().toISOString();
    expect(hoursSinceFlagged(now)).toBeLessThan(0.01);
  });

  it('returns approximately 24 for 24 hours ago', () => {
    const hoursAgo24 = new Date(Date.now() - 24 * 3_600_000).toISOString();
    const result = hoursSinceFlagged(hoursAgo24);
    expect(result).toBeGreaterThanOrEqual(23.99);
    expect(result).toBeLessThanOrEqual(24.01);
  });

  it('returns positive values for past timestamps', () => {
    const past = new Date(Date.now() - 5 * 3_600_000).toISOString();
    expect(hoursSinceFlagged(past)).toBeGreaterThan(0);
  });
});

describe('validateDateRange', () => {
  it('accepts a valid 30-day range', () => {
    const start = '2024-01-01';
    const end = '2024-01-31';
    expect(validateDateRange(start, end)).toEqual({ valid: true });
  });

  it('accepts a 1-day range', () => {
    const start = '2024-06-01';
    const end = '2024-06-02';
    expect(validateDateRange(start, end)).toEqual({ valid: true });
  });

  it('accepts a 365-day range', () => {
    const start = '2024-01-01';
    const end = '2024-12-31';
    expect(validateDateRange(start, end)).toEqual({ valid: true });
  });

  it('rejects when start is after end', () => {
    const result = validateDateRange('2024-06-15', '2024-06-01');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('before');
  });

  it('rejects ranges shorter than 1 day', () => {
    const result = validateDateRange('2024-06-01', '2024-06-01');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('at least 1 day');
  });

  it('rejects ranges longer than 365 days', () => {
    const result = validateDateRange('2023-01-01', '2024-06-01');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('365');
  });

  it('rejects invalid date strings', () => {
    const result = validateDateRange('not-a-date', '2024-01-01');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('Invalid');
  });

  it('rejects when both dates are invalid', () => {
    const result = validateDateRange('foo', 'bar');
    expect(result.valid).toBe(false);
  });
});
