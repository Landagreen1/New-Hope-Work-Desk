'use client';

/**
 * Editing one section of the master application.
 *
 * Contextual by design: there is no global "Edit Quote" form in this workspace, so
 * Coverage opens Coverage and Cargo opens Cargo. The declaration in `intake-fields.ts`
 * says what a section offers and this file renders it — which is why adding a field is
 * one line there and nothing here.
 *
 * Three things it is careful about:
 *
 * 1. **Only what changed is sent.** The patch carries the keys the reader actually
 *    touched, so two people editing different sections of the same intake do not
 *    overwrite each other's untouched columns.
 * 2. **Blank is a value.** Clearing a field sends null, which is how a wrong answer
 *    gets removed. That is different from not touching it, and the two are kept apart.
 * 3. **Not recorded is an answer.** Yes/No fields are three-way, and the cargo and
 *    coverage questions that allow Unsure keep it, because a guessed No is worse for an
 *    underwriter than an honest Unsure.
 *
 * Concurrency is checked against `intake.version`, not the opportunity's — the row
 * being written is the Customer Service intake, and that is the version the server
 * compares.
 */

import { useMemo, useState } from 'react';

import { EXCLUDED_CARGO_ITEMS } from '../../cs-intake/CargoSection';
import DollarInput from '../../nhwd-shared/DollarInput';
import { ui } from '../../nhwd-shared/ui';
import { updateLinkedIntake } from '../api';
import type { SectionKey } from '../application';
import type { LinkedIntake, SpecialtyLine } from '../types';
import { EditModal, Field, type Runner } from './shared';
import { fieldsForSection, type IntakeFieldSpec } from './intake-fields';

/** Everything is held as a string except the array and map columns. */
type Draft = Record<string, string>;

function seed(intake: LinkedIntake, fields: readonly IntakeFieldSpec[]): Draft {
  const draft: Draft = {};
  const row = intake as unknown as Record<string, unknown>;
  for (const field of fields) {
    const value = row[field.key];
    if (field.type === 'multiselect') continue;
    draft[field.key] =
      value === null || value === undefined ? '' : typeof value === 'boolean' ? String(value) : String(value);
  }
  return draft;
}

function convert(field: IntakeFieldSpec, raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  switch (field.type) {
    case 'number':
    case 'money':
      return Number(trimmed);
    case 'boolean':
      return trimmed === 'true';
    default:
      return trimmed;
  }
}

export default function IntakeEditDialog({
  section,
  sectionLabel,
  line,
  intake,
  opportunityId,
  run,
  busy,
  onClose,
}: {
  section: SectionKey;
  sectionLabel: string;
  line: SpecialtyLine;
  intake: LinkedIntake;
  opportunityId: string;
  run: Runner;
  busy: boolean;
  onClose: () => void;
}) {
  const fields = useMemo(() => fieldsForSection(section, line), [line, section]);

  const [draft, setDraft] = useState<Draft>(() => seed(intake, fields));
  const [touched, setTouched] = useState<Set<string>>(new Set());
  /**
   * The version these values were read at, captured with them.
   *
   * Not `intake.version` at save time. The page refetches on a realtime event, on window
   * focus and after any teammate's action, so by the time Save is pressed the prop may
   * carry a newer version than the fields on screen were read from. Submitting that newer
   * version would make the server accept a stale form — a silent overwrite of whatever
   * the teammate just changed. Submitting the version we actually read earns a proper
   * 40001 refusal and the conflict banner instead.
   */
  const [seededVersion] = useState(intake.version);
  const [operations, setOperations] = useState<string[]>(() => intake.operation_types ?? []);
  const [operationsTouched, setOperationsTouched] = useState(false);
  const [excluded, setExcluded] = useState<Record<string, string>>(
    () => intake.excluded_cargo ?? {},
  );
  const [excludedTouched, setExcludedTouched] = useState(false);

  const showExcludedCargo = section === 'cargo';
  const hasOperations = fields.some((field) => field.key === 'operation_types');

  const set = (key: string, value: string) => {
    setDraft((current) => ({ ...current, [key]: value }));
    setTouched((current) => new Set(current).add(key));
  };

  const changedCount =
    touched.size + (operationsTouched ? 1 : 0) + (excludedTouched ? 1 : 0);

  return (
    <EditModal
      title={`Edit ${sectionLabel.toLowerCase()}`}
      description="Written to the original Customer Service intake, not to a copy — so Customer Service and the specialty team never disagree about the same fact. Only what you change is sent."
      onClose={onClose}
      busy={busy}
      wide
      submitDisabled={changedCount === 0}
      submitLabel={changedCount === 0 ? 'Nothing changed' : `Save ${changedCount} change${changedCount === 1 ? '' : 's'}`}
      onSubmit={() =>
        void run(async () => {
          const patch: Record<string, unknown> = {};
          for (const key of touched) {
            const field = fields.find((entry) => entry.key === key);
            if (!field) continue;
            patch[key] = convert(field, draft[key] ?? '');
          }
          if (operationsTouched) {
            patch.operation_types = operations.length > 0 ? operations : null;
          }
          if (excludedTouched) {
            const cleaned = Object.fromEntries(
              Object.entries(excluded).filter(([, answer]) => answer !== ''),
            );
            patch.excluded_cargo = Object.keys(cleaned).length > 0 ? cleaned : null;
          }
          await updateLinkedIntake(opportunityId, patch, seededVersion);
        }, `${sectionLabel} was updated on the intake.`).then((ok) => {
          if (ok) onClose();
        })
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        {fields.map((field) => {
          if (field.type === 'multiselect') return null;
          const value = draft[field.key] ?? '';
          const wrapperClass = field.wide ? 'sm:col-span-2' : undefined;

          return (
            <div key={field.key} className={wrapperClass}>
              <Field label={field.label} hint={field.hint}>
                {field.type === 'textarea' ? (
                  <textarea
                    className={ui.textarea}
                    rows={3}
                    value={value}
                    onChange={(event) => set(field.key, event.target.value)}
                  />
                ) : field.type === 'money' ? (
                  <DollarInput
                    value={value === '' ? null : Number(value)}
                    onChange={(next) => set(field.key, next === null ? '' : String(next))}
                  />
                ) : field.type === 'boolean' ? (
                  <select
                    className={ui.select}
                    value={value}
                    onChange={(event) => set(field.key, event.target.value)}
                  >
                    <option value="">Not recorded</option>
                    <option value="true">Yes</option>
                    <option value="false">No</option>
                  </select>
                ) : field.type === 'tristate' ? (
                  <select
                    className={ui.select}
                    value={value}
                    onChange={(event) => set(field.key, event.target.value)}
                  >
                    <option value="">Not recorded</option>
                    <option value="yes">Yes</option>
                    <option value="no">No</option>
                    <option value="unsure">Unsure</option>
                  </select>
                ) : field.type === 'select' ? (
                  <select
                    className={ui.select}
                    value={value}
                    onChange={(event) => set(field.key, event.target.value)}
                  >
                    <option value="">Not recorded</option>
                    {(field.options ?? []).map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    className={ui.input}
                    type={field.type === 'number' ? 'number' : field.type === 'date' ? 'date' : 'text'}
                    value={field.type === 'date' ? value.slice(0, 10) : value}
                    onChange={(event) => set(field.key, event.target.value)}
                  />
                )}
              </Field>
            </div>
          );
        })}

        {hasOperations ? (
          <div className="sm:col-span-2">
            <span className={ui.label}>Type of operation</span>
            <div className="mt-2 flex flex-wrap gap-x-5 gap-y-2">
              {(fieldsForSection('operations', line).find(
                (field) => field.key === 'operation_types',
              )?.options ?? []).map((option) => (
                <label key={option.value} className={ui.checkboxRow}>
                  <input
                    type="checkbox"
                    checked={operations.includes(option.value)}
                    onChange={(event) => {
                      setOperationsTouched(true);
                      setOperations((current) =>
                        event.target.checked
                          ? [...current, option.value]
                          : current.filter((entry) => entry !== option.value),
                      );
                    }}
                  />
                  {option.label}
                </label>
              ))}
            </div>
          </div>
        ) : null}

        {showExcludedCargo ? (
          <div className="sm:col-span-2">
            <span className={ui.label}>Prohibited cargo</span>
            <p className="mt-1 text-xs font-semibold text-slate-400">
              An unanswered row is what sends an application back. Yes means they do haul it.
            </p>
            <div className="mt-2 grid gap-2 sm:grid-cols-2">
              {EXCLUDED_CARGO_ITEMS.map((item) => (
                <label
                  key={item}
                  className="flex items-center justify-between gap-2 rounded-xl border border-slate-200 px-3 py-2 text-sm font-semibold text-slate-700"
                >
                  {item}
                  <select
                    className="rounded-lg border border-slate-200 px-2 py-1 text-xs font-black text-slate-700"
                    value={excluded[item] ?? ''}
                    onChange={(event) => {
                      setExcludedTouched(true);
                      setExcluded((current) => ({ ...current, [item]: event.target.value }));
                    }}
                  >
                    <option value="">—</option>
                    <option value="yes">Yes</option>
                    <option value="no">No</option>
                  </select>
                </label>
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </EditModal>
  );
}
