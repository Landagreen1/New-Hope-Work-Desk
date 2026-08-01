// The pure decisions the four Review views make, checked by example.
//
// Everything these views display comes from a service read, so what is left to
// get wrong is the *question*: which range a preset stands for, which parameters
// an export carries, and whether a filter survives the round trip to the route
// and back. Those are the four functions checked here.
//
// The property tests for CSV serialisation, export and view agreement, the metric
// control's accessible name, and virtualisation are tasks 20.5 through 20.8.

import { describe, expect, it } from 'vitest';

import { parseAuditQuery } from '../../server/request-query';
import { auditQuerySearchParams } from '../../shared/audit-query';
import { auditViewQuery, valueLines, workDateFilterValue } from '../AuditLogView';
import { exportUrl, triggerReadiness, EXPORT_TRIGGERS } from '../ExportsView';
import { previousPayPeriod, resolveDatePreset } from '../OverviewView';

const PERIODS = [
  { id: 'p3', from: '2026-08-01', to: '2026-08-15', payDate: null, status: 'open' as const },
  { id: 'p2', from: '2026-07-16', to: '2026-07-31', payDate: null, status: 'paid' as const },
  { id: 'p1', from: '2026-07-01', to: '2026-07-15', payDate: null, status: 'paid' as const },
];

const CUSTOM = { from: '2026-01-01', to: '2026-01-31' };

describe('overview date presets', () => {
  // 2026-08-12 is a Wednesday.
  const today = '2026-08-12';

  it('resolves the five arithmetic presets', () => {
    expect(resolveDatePreset('today', today, PERIODS, PERIODS[0], CUSTOM)).toEqual({
      available: true,
      range: { from: today, to: today },
    });
    expect(resolveDatePreset('yesterday', today, PERIODS, PERIODS[0], CUSTOM)).toEqual({
      available: true,
      range: { from: '2026-08-11', to: '2026-08-11' },
    });
    expect(resolveDatePreset('this_week', today, PERIODS, PERIODS[0], CUSTOM)).toEqual({
      available: true,
      range: { from: '2026-08-10', to: '2026-08-16' },
    });
    expect(resolveDatePreset('last_week', today, PERIODS, PERIODS[0], CUSTOM)).toEqual({
      available: true,
      range: { from: '2026-08-03', to: '2026-08-09' },
    });
    expect(resolveDatePreset('custom', today, PERIODS, PERIODS[0], CUSTOM)).toEqual({
      available: true,
      range: CUSTOM,
    });
  });

  it('resolves a Sunday to the Monday before it', () => {
    expect(resolveDatePreset('this_week', '2026-08-16', PERIODS, null, CUSTOM)).toEqual({
      available: true,
      range: { from: '2026-08-10', to: '2026-08-16' },
    });
  });

  it('resolves the two payroll presets and reports an unavailable one', () => {
    expect(resolveDatePreset('current_pay_period', today, PERIODS, PERIODS[0], CUSTOM)).toEqual({
      available: true,
      range: { from: '2026-08-01', to: '2026-08-15' },
    });
    expect(resolveDatePreset('previous_pay_period', today, PERIODS, PERIODS[0], CUSTOM)).toEqual({
      available: true,
      range: { from: '2026-07-16', to: '2026-07-31' },
    });
    expect(resolveDatePreset('current_pay_period', today, [], null, CUSTOM).available).toBe(false);
    expect(resolveDatePreset('previous_pay_period', today, [], null, CUSTOM).available).toBe(false);
  });

  it('reads previous relative to today when no period covers today', () => {
    expect(previousPayPeriod(PERIODS, null, '2026-08-20')?.id).toBe('p3');
    // Nothing ended before the earliest period began.
    expect(previousPayPeriod(PERIODS, PERIODS[2], today)).toBeNull();
  });
});

describe('audit query round trip', () => {
  it('parses back what it serialises', () => {
    const query = auditViewQuery(
      {
        profileId: '11111111-1111-4111-8111-111111111111',
        from: '2026-08-01',
        to: '2026-08-15',
        action: 'correct_punch',
        actorProfileId: '22222222-2222-4222-8222-222222222222',
      },
      3,
    );

    const { params, unsatisfiable } = auditQuerySearchParams(query);
    expect(unsatisfiable).toBe(false);
    expect(parseAuditQuery(params)).toEqual(query);
  });

  it('refuses an action outside the vocabulary', () => {
    expect(() => parseAuditQuery(new URLSearchParams('action=deleted_everything'))).toThrow();
  });
});

describe('audit value rendering', () => {
  it('renders one line per recorded field', () => {
    expect(valueLines({ clock_out: null, total_hours: 8 })).toEqual([
      { key: 'Clock Out', text: 'none' },
      { key: 'Total Hours', text: '8' },
    ]);
    expect(valueLines(null)).toEqual([{ key: null, text: 'none' }]);
    expect(valueLines('a reason')).toEqual([{ key: null, text: 'a reason' }]);
  });

  it('states a one-sided work-date filter', () => {
    expect(workDateFilterValue(null, null)).toBe('All dates');
    expect(workDateFilterValue('2026-08-01', null)).toContain('onwards');
    expect(workDateFilterValue(null, '2026-08-01')).toContain('up to');
    expect(workDateFilterValue('2026-08-01', '2026-08-15')).toContain('to');
  });
});

describe('export triggers', () => {
  const selection = {
    range: { from: '2026-08-01', to: '2026-08-15' },
    savedFilter: 'payroll_blocking' as const,
    department: 'sales' as const,
    profileId: '33333333-3333-4333-8333-333333333333',
  };

  it('names one url per view and carries only that view\u2019s filters', () => {
    const urls = EXPORT_TRIGGERS.map((trigger) => exportUrl(trigger, selection));
    expect(urls).toHaveLength(6);
    expect(urls[0]).toContain('saved_filter=payroll_blocking');
    expect(urls[2]).not.toContain('saved_filter');
    expect(urls[4]).toContain('department=sales');
    expect(urls[5]).toContain('profile_id=33333333-3333-4333-8333-333333333333');
  });

  it('withholds the trends export until an employee is chosen', () => {
    const trends = EXPORT_TRIGGERS.find((t) => t.view === 'employee_trends');
    expect(trends).toBeDefined();
    expect(triggerReadiness(trends!, { ...selection, profileId: null }).ready).toBe(false);
    expect(triggerReadiness(trends!, selection).ready).toBe(true);
  });
});
