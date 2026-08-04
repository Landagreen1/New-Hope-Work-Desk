'use client';

/**
 * The persistent global filter bar.
 *
 * Spec: .kiro/specs/sales-reporting-center-redesign
 * Requirements: 3.1, 3.7, 9.1-9.5, 9.9, 17.5
 *
 * Rendered above every one of the four views, so switching view never loses a filter.
 * Zero data access: the option lists arrive as props from the shell, which loads them
 * once per session (Requirement 17.5).
 *
 * The source and salesperson selects are linked. Selecting a source narrows the
 * salesperson list to that source's people, and clearing the source drops any
 * salesperson that no longer belongs to the remaining scope. Without that, a manager
 * could hold a filter pair that describes nobody and see an empty report with no
 * indication why.
 */

import { useMemo, useState } from 'react';

import { ui } from '../nhwd-shared-bridge';
import { AFTER_HOURS_DIMENSIONS, HOURS_SEGMENTS, REPORT_MODES } from '../definitions';
import { assignmentMethodLabel } from '../derive';
import {
  WINDOW_PRESETS,
  clearDimensionFilters,
  hasActiveDimensionFilters,
  resolvePreset,
  type WindowPreset,
} from '../url-state';
import type { FilterOptions, ReportFilters } from '../types';

const HOURS_SEGMENT_LABELS: Record<string, string> = {
  all: 'All Hours',
  business: 'Business Hours',
  after: 'After Hours',
  sunday: 'Sunday',
};

const DIMENSION_LABELS: Record<string, string> = {
  received: 'Received After Hours',
  worked: 'Worked After Hours',
  finalized: 'Finalized After Hours',
  manual_entry: 'Manual Entry After Hours',
};

const MODE_LABELS: Record<string, string> = {
  activity: 'Operational Activity',
  cohort: 'Quote Cohort',
};

const MODE_QUESTIONS: Record<string, string> = {
  activity: 'What work happened during the selected period?',
  cohort: 'What happened to the quotes received during the selected period?',
};

function MultiSelect({
  label,
  options,
  selected,
  onChange,
  disabled = false,
  disabledHint,
}: {
  label: string;
  options: ReadonlyArray<{ value: string; label: string }>;
  selected: readonly string[];
  onChange: (next: string[]) => void;
  disabled?: boolean;
  disabledHint?: string;
}) {
  return (
    <label className="block min-w-0">
      <span className={ui.label}>{label}</span>
      <select
        multiple
        disabled={disabled}
        value={selected as string[]}
        onChange={(event) =>
          onChange(Array.from(event.target.selectedOptions, (option) => option.value))
        }
        className={`${ui.select} h-[7.5rem] disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-400`}
        aria-label={label}
      >
        {disabled && disabledHint !== undefined ? (
          <option value="">{disabledHint}</option>
        ) : null}
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

export function ReportingFilters({
  filters,
  options,
  onChange,
  droppedKeys,
  timeZone,
}: {
  filters: ReportFilters;
  options: FilterOptions | null;
  onChange: (next: ReportFilters) => void;
  droppedKeys: readonly string[];
  timeZone: string;
}) {
  const [showAll, setShowAll] = useState(false);

  const activePreset = useMemo<WindowPreset>(() => {
    for (const preset of WINDOW_PRESETS) {
      if (preset.id === 'custom') continue;
      const window = resolvePreset(preset.id);
      if (window.startDate === filters.startDate && window.endDate === filters.endDate) {
        return preset.id;
      }
    }
    return 'custom';
  }, [filters.startDate, filters.endDate]);

  // Requirement 9.5: salesperson options follow the selected source.
  const salespersonOptions = useMemo(() => {
    const all = options?.salespeople ?? [];
    const scoped =
      filters.dealerIds.length === 0
        ? all
        : all.filter((person) => filters.dealerIds.includes(person.dealer_id));
    return scoped.map((person) => ({ value: person.id, label: person.name }));
  }, [options, filters.dealerIds]);

  function applyPreset(preset: WindowPreset) {
    if (preset === 'custom') {
      onChange({ ...filters, page: 1 });
      return;
    }
    const window = resolvePreset(preset);
    onChange({ ...filters, ...window, page: 1 });
  }

  function setSources(next: string[]) {
    const allowed = new Set(
      (options?.salespeople ?? [])
        .filter((person) => next.length === 0 || next.includes(person.dealer_id))
        .map((person) => person.id),
    );
    onChange({
      ...filters,
      dealerIds: next,
      // Drop a salesperson who no longer belongs to the remaining source scope.
      salespersonIds: filters.salespersonIds.filter((id) => allowed.has(id)),
      page: 1,
    });
  }

  function toggleDimension(dimension: string) {
    const active = filters.afterHoursDimensions.includes(
      dimension as (typeof AFTER_HOURS_DIMENSIONS)[number],
    );
    onChange({
      ...filters,
      afterHoursDimensions: active
        ? filters.afterHoursDimensions.filter((value) => value !== dimension)
        : [...filters.afterHoursDimensions, dimension as (typeof AFTER_HOURS_DIMENSIONS)[number]],
      page: 1,
    });
  }

  const filtersActive = hasActiveDimensionFilters(filters);

  return (
    <section className={`${ui.card} sticky top-0 z-20`}>
      <div className="flex flex-col gap-4 px-5 py-4 sm:px-6">
        {droppedKeys.length > 0 ? (
          <p className={ui.info}>
            This link named {droppedKeys.length === 1 ? 'a value' : 'values'} this report
            does not offer ({droppedKeys.join(', ')}). {droppedKeys.length === 1 ? 'It was' : 'They were'}{' '}
            dropped and the default applied.
          </p>
        ) : null}

        {/* Report mode */}
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex rounded-xl border border-slate-200 p-1">
            {REPORT_MODES.map((mode) => (
              <button
                key={mode}
                type="button"
                onClick={() => onChange({ ...filters, mode, page: 1 })}
                className={`rounded-lg px-4 py-2 text-sm font-black transition ${
                  filters.mode === mode
                    ? 'bg-[#223f7a] text-white shadow-sm'
                    : 'text-slate-600 hover:bg-slate-100'
                }`}
                aria-pressed={filters.mode === mode}
              >
                {MODE_LABELS[mode]}
              </button>
            ))}
          </div>
          <p className="text-xs font-semibold text-slate-500">
            {MODE_QUESTIONS[filters.mode]}
          </p>
        </div>

        {/* Window presets and custom range */}
        <div className="flex flex-wrap items-end gap-2">
          {WINDOW_PRESETS.map((preset) => (
            <button
              key={preset.id}
              type="button"
              onClick={() => applyPreset(preset.id)}
              className={`rounded-xl px-3 py-2 text-xs font-black transition ${
                activePreset === preset.id
                  ? 'bg-[#223f7a] text-white'
                  : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
              }`}
              aria-pressed={activePreset === preset.id}
            >
              {preset.label}
            </button>
          ))}
          <label className="ml-1 block">
            <span className="sr-only">Start date</span>
            <input
              type="date"
              value={filters.startDate}
              onChange={(event) =>
                onChange({ ...filters, startDate: event.target.value, page: 1 })
              }
              className="rounded-xl border border-slate-200 px-3 py-2 text-xs font-bold text-slate-700"
              aria-label="Start date"
            />
          </label>
          <span className="pb-2 text-xs font-bold text-slate-400">to</span>
          <label className="block">
            <span className="sr-only">End date</span>
            <input
              type="date"
              value={filters.endDate}
              onChange={(event) =>
                onChange({ ...filters, endDate: event.target.value, page: 1 })
              }
              className="rounded-xl border border-slate-200 px-3 py-2 text-xs font-bold text-slate-700"
              aria-label="End date"
            />
          </label>
          <label className={`${ui.checkboxRow} pb-1`}>
            <input
              type="checkbox"
              checked={filters.compareToPreviousPeriod}
              onChange={(event) =>
                onChange({ ...filters, compareToPreviousPeriod: event.target.checked })
              }
            />
            Compare with previous period
          </label>
          <span className="pb-2 text-[11px] font-bold text-slate-400">
            All dates in {timeZone}
          </span>
        </div>

        {/* Hours segment and the four after-hours dimensions */}
        <div className="flex flex-wrap items-center gap-2">
          <span className={ui.label}>Hours</span>
          <div className="flex rounded-xl border border-slate-200 p-1">
            {HOURS_SEGMENTS.map((segment) => (
              <button
                key={segment}
                type="button"
                onClick={() => onChange({ ...filters, hoursSegment: segment, page: 1 })}
                className={`rounded-lg px-3 py-1.5 text-xs font-black transition ${
                  filters.hoursSegment === segment
                    ? 'bg-[#223f7a] text-white'
                    : 'text-slate-600 hover:bg-slate-100'
                }`}
                aria-pressed={filters.hoursSegment === segment}
              >
                {HOURS_SEGMENT_LABELS[segment]}
              </button>
            ))}
          </div>
          <span className="mx-1 h-6 w-px bg-slate-200" aria-hidden="true" />
          {AFTER_HOURS_DIMENSIONS.map((dimension) => {
            const active = filters.afterHoursDimensions.includes(dimension);
            return (
              <button
                key={dimension}
                type="button"
                onClick={() => toggleDimension(dimension)}
                className={`rounded-full px-3 py-1.5 text-[11px] font-black ring-1 transition ${
                  active
                    ? 'bg-violet-100 text-violet-800 ring-violet-300'
                    : 'bg-white text-slate-500 ring-slate-200 hover:bg-slate-50'
                }`}
                aria-pressed={active}
              >
                {DIMENSION_LABELS[dimension]}
              </button>
            );
          })}
        </div>

        {/* Dimension filters */}
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => setShowAll((value) => !value)}
            className={ui.btnSecondary}
            aria-expanded={showAll}
          >
            {showAll ? 'Hide filters' : 'More filters'}
          </button>
          {filtersActive ? (
            <button
              type="button"
              onClick={() => onChange(clearDimensionFilters(filters))}
              className={ui.btnGhost}
            >
              Clear all filters
            </button>
          ) : null}
        </div>

        {showAll ? (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <MultiSelect
              label="Agent"
              options={(options?.agents ?? []).map((agent) => ({
                value: agent.id,
                label: agent.is_active ? agent.name : `${agent.name} (inactive)`,
              }))}
              selected={filters.agentProfileIds}
              onChange={(next) => onChange({ ...filters, agentProfileIds: next, page: 1 })}
            />
            <MultiSelect
              label="Source / dealership"
              options={(options?.dealers ?? []).map((dealer) => ({
                value: dealer.id,
                label: dealer.is_active ? dealer.name : `${dealer.name} (inactive)`,
              }))}
              selected={filters.dealerIds}
              onChange={setSources}
            />
            <MultiSelect
              label="Salesperson"
              options={salespersonOptions}
              selected={filters.salespersonIds}
              onChange={(next) => onChange({ ...filters, salespersonIds: next, page: 1 })}
              disabled={salespersonOptions.length === 0}
              disabledHint="Select a source first"
            />
            <MultiSelect
              label="Input channel"
              options={(options?.channels ?? []).map((channel) => ({
                value: channel,
                label: channel,
              }))}
              selected={filters.channels}
              onChange={(next) => onChange({ ...filters, channels: next, page: 1 })}
            />
            <MultiSelect
              label="New Quote or Requote"
              options={[
                { value: 'new_quote', label: 'New Quote' },
                { value: 'requote', label: 'Requote' },
              ]}
              selected={filters.quoteKinds}
              onChange={(next) =>
                onChange({
                  ...filters,
                  quoteKinds: next as Array<'new_quote' | 'requote'>,
                  page: 1,
                })
              }
            />
            <MultiSelect
              label="Assignment method"
              options={(options?.assignment_methods ?? []).map((method) => ({
                value: method,
                label: assignmentMethodLabel(method),
              }))}
              selected={filters.assignmentMethods}
              onChange={(next) => onChange({ ...filters, assignmentMethods: next, page: 1 })}
            />
            <MultiSelect
              label="Quote status"
              options={[
                { value: 'active', label: 'Active' },
                { value: 'pending_pricing', label: 'Pending Pricing' },
                { value: 'finalized', label: 'Finalized' },
              ]}
              selected={filters.statuses}
              onChange={(next) => onChange({ ...filters, statuses: next, page: 1 })}
            />
            <MultiSelect
              label="Outcome"
              options={[
                { value: 'sold', label: 'Sold' },
                { value: 'not_sold', label: 'Not Sold' },
              ]}
              selected={filters.outcomes}
              onChange={(next) =>
                onChange({
                  ...filters,
                  outcomes: next as Array<'sold' | 'not_sold'>,
                  page: 1,
                })
              }
            />
          </div>
        ) : null}
      </div>
    </section>
  );
}
