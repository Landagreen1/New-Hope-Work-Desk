'use client';

import { ChevronDown, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ui } from './ui';

const US_STATES = [
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'FL', 'GA',
  'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD',
  'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ',
  'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC',
  'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY', 'DC',
];

const STATE_NAMES: Record<string, string> = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California',
  CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware', FL: 'Florida', GA: 'Georgia',
  HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa',
  KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland',
  MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri',
  MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey',
  NM: 'New Mexico', NY: 'New York', NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio',
  OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina',
  SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont',
  VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming', DC: 'District of Columbia',
};

interface StatesMultiSelectProps {
  value: string; // comma-separated state codes, e.g. "TX, FL, GA"
  onChange: (value: string) => void;
  disabled?: boolean;
  placeholder?: string;
}

export default function StatesMultiSelect({ value, onChange, disabled = false, placeholder = 'Select states...' }: StatesMultiSelectProps) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState('');
  const containerRef = useRef<HTMLDivElement>(null);
  const filterRef = useRef<HTMLInputElement>(null);

  const selected = value ? value.split(',').map(s => s.trim()).filter(Boolean) : [];

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  useEffect(() => {
    if (open && filterRef.current) filterRef.current.focus();
  }, [open]);

  const toggle = useCallback((state: string) => {
    const next = selected.includes(state)
      ? selected.filter(s => s !== state)
      : [...selected, state];
    onChange(next.join(', '));
  }, [selected, onChange]);

  const remove = useCallback((state: string) => {
    onChange(selected.filter(s => s !== state).join(', '));
  }, [selected, onChange]);

  const filtered = US_STATES.filter(s => {
    if (!filter) return true;
    const q = filter.toLowerCase();
    return s.toLowerCase().includes(q) || STATE_NAMES[s].toLowerCase().includes(q);
  });

  return (
    <div ref={containerRef} className="relative mt-2">
      {/* Display area */}
      <button
        type="button"
        onClick={() => !disabled && setOpen(!open)}
        disabled={disabled}
        className={`${ui.input} mt-0 flex min-h-[42px] cursor-pointer flex-wrap items-center gap-1.5 pr-8 text-left`}
      >
        {selected.length === 0 && <span className="text-slate-400">{placeholder}</span>}
        {selected.map(s => (
          <span key={s} className="inline-flex items-center gap-0.5 rounded-md bg-[#eef3fb] px-1.5 py-0.5 text-xs font-black text-[#223f7a]">
            {s}
            {!disabled && (
              <span
                role="button"
                onClick={(e) => { e.stopPropagation(); remove(s); }}
                className="ml-0.5 cursor-pointer rounded hover:bg-[#d5e3f7]"
              >
                <X className="h-3 w-3" />
              </span>
            )}
          </span>
        ))}
        <ChevronDown className="absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
      </button>

      {/* Dropdown */}
      {open && (
        <div className="absolute left-0 top-full z-50 mt-1 w-full max-h-60 overflow-y-auto rounded-xl border border-slate-200 bg-white shadow-xl">
          <div className="sticky top-0 z-10 border-b border-slate-100 bg-white p-2">
            <input
              ref={filterRef}
              type="text"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Search states..."
              className="w-full rounded-lg border border-slate-200 px-2.5 py-1.5 text-sm outline-none focus:border-[#7890bc] focus:ring-2 focus:ring-[#eef3fb]"
            />
          </div>
          {filtered.map(s => (
            <button
              key={s}
              type="button"
              onClick={() => toggle(s)}
              className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition hover:bg-slate-50 ${
                selected.includes(s) ? 'bg-[#eef3fb] font-black text-[#223f7a]' : 'text-slate-700'
              }`}
            >
              <input
                type="checkbox"
                checked={selected.includes(s)}
                readOnly
                className="h-3.5 w-3.5 rounded border-slate-300 text-[#223f7a] focus:ring-0"
              />
              <span className="font-bold">{s}</span>
              <span className="text-xs text-slate-400">{STATE_NAMES[s]}</span>
            </button>
          ))}
          {filtered.length === 0 && (
            <div className="px-3 py-4 text-center text-sm text-slate-400">No states match</div>
          )}
        </div>
      )}
    </div>
  );
}
