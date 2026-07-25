'use client';

import { Clock } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

interface TimePickerProps {
  value: string; // HH:mm (24-hour)
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
}

function to12(h24: number): { hour: number; minute: number; period: 'AM' | 'PM'; display: string } {
  const period: 'AM' | 'PM' = h24 >= 12 ? 'PM' : 'AM';
  const hour = h24 === 0 ? 12 : h24 > 12 ? h24 - 12 : h24;
  return { hour, minute: 0, period, display: '' };
}

function formatDisplay(value: string): string {
  if (!value) return '';
  const [hStr, mStr] = value.split(':');
  const h24 = parseInt(hStr, 10);
  const m = parseInt(mStr, 10) || 0;
  if (isNaN(h24)) return '';
  const period = h24 >= 12 ? 'PM' : 'AM';
  const h12 = h24 === 0 ? 12 : h24 > 12 ? h24 - 12 : h24;
  return `${h12}:${String(m).padStart(2, '0')} ${period}`;
}

// Generate preset times every 30 minutes from 6:00 AM to 10:00 PM
function generatePresets(): Array<{ label: string; value: string }> {
  const presets: Array<{ label: string; value: string }> = [];
  for (let h = 6; h <= 22; h++) {
    for (const m of [0, 30]) {
      if (h === 22 && m === 30) break;
      const h24 = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
      const period = h >= 12 ? 'PM' : 'AM';
      const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
      const label = `${h12}:${String(m).padStart(2, '0')} ${period}`;
      presets.push({ label, value: h24 });
    }
  }
  return presets;
}

const PRESETS = generatePresets();

function parseManualInput(input: string): string | null {
  const trimmed = input.trim().toUpperCase();
  if (!trimmed) return null;

  // Try HH:MM AM/PM format
  const ampmMatch = trimmed.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/);
  if (ampmMatch) {
    let h = parseInt(ampmMatch[1], 10);
    const m = parseInt(ampmMatch[2], 10);
    const period = ampmMatch[3];
    if (h < 1 || h > 12 || m < 0 || m > 59) return null;
    if (period === 'AM' && h === 12) h = 0;
    else if (period === 'PM' && h !== 12) h += 12;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  }

  // Try HH:MM (24-hour) format
  const h24Match = trimmed.match(/^(\d{1,2}):(\d{2})$/);
  if (h24Match) {
    const h = parseInt(h24Match[1], 10);
    const m = parseInt(h24Match[2], 10);
    if (h < 0 || h > 23 || m < 0 || m > 59) return null;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  }

  // Try just hour with AM/PM: "9AM", "2PM"
  const shortMatch = trimmed.match(/^(\d{1,2})\s*(AM|PM)$/);
  if (shortMatch) {
    let h = parseInt(shortMatch[1], 10);
    const period = shortMatch[2];
    if (h < 1 || h > 12) return null;
    if (period === 'AM' && h === 12) h = 0;
    else if (period === 'PM' && h !== 12) h += 12;
    return `${String(h).padStart(2, '0')}:00`;
  }

  return null;
}

export default function TimePicker({ value, onChange, placeholder = 'Select time', disabled = false, className = '' }: TimePickerProps) {
  const [open, setOpen] = useState(false);
  const [manualInput, setManualInput] = useState('');
  const [manualError, setManualError] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Close on click outside
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  // Scroll to selected preset when opening
  useEffect(() => {
    if (open && listRef.current && value) {
      const selected = listRef.current.querySelector('[data-selected="true"]');
      if (selected) selected.scrollIntoView({ block: 'center', behavior: 'instant' });
    }
  }, [open, value]);

  const handleManualSubmit = () => {
    const parsed = parseManualInput(manualInput);
    if (parsed) {
      onChange(parsed);
      setManualInput('');
      setManualError(false);
      setOpen(false);
    } else {
      setManualError(true);
    }
  };

  const handlePresetClick = (preset: string) => {
    onChange(preset);
    setOpen(false);
  };

  const displayValue = formatDisplay(value);

  return (
    <div ref={containerRef} className={`relative ${className}`}>
      {/* Trigger */}
      <button
        type="button"
        onClick={() => { if (!disabled) { setOpen(!open); setManualError(false); setManualInput(''); } }}
        disabled={disabled}
        className={`flex w-full items-center gap-3 rounded-xl border px-3.5 py-2.5 text-left text-sm font-semibold transition outline-none ${
          open
            ? 'border-[#223f7a] ring-4 ring-[#eef3fb]'
            : 'border-slate-200 hover:border-slate-300'
        } ${disabled ? 'cursor-not-allowed bg-slate-50 opacity-60' : 'bg-white'}`}
      >
        <Clock className="h-4 w-4 shrink-0 text-[#223f7a]" />
        <span className={displayValue ? 'text-slate-900' : 'text-slate-400'}>
          {displayValue || placeholder}
        </span>
      </button>

      {/* Dropdown */}
      {open && (
        <div className="absolute left-0 top-full z-50 mt-2 w-[200px] rounded-2xl border border-slate-200 bg-white shadow-xl animate-in fade-in-0 zoom-in-95">
          {/* Manual input */}
          <div className="border-b border-slate-100 p-3">
            <div className="flex gap-1.5">
              <input
                type="text"
                value={manualInput}
                onChange={(e) => { setManualInput(e.target.value); setManualError(false); }}
                onKeyDown={(e) => { if (e.key === 'Enter') handleManualSubmit(); }}
                placeholder="e.g. 9:30 AM"
                className={`flex-1 rounded-lg border px-2.5 py-1.5 text-xs font-semibold outline-none transition ${
                  manualError ? 'border-rose-300 bg-rose-50' : 'border-slate-200 focus:border-[#223f7a]'
                }`}
                autoFocus
              />
              <button
                type="button"
                onClick={handleManualSubmit}
                className="rounded-lg bg-[#223f7a] px-2.5 py-1.5 text-[10px] font-black text-white hover:bg-[#17305f]"
              >
                Set
              </button>
            </div>
            {manualError && <p className="mt-1 text-[10px] font-bold text-rose-600">Try: 9:30 AM or 14:00</p>}
          </div>

          {/* Preset list */}
          <div ref={listRef} className="max-h-[240px] overflow-y-auto p-1.5">
            {PRESETS.map((preset) => {
              const isSelected = preset.value === value;
              return (
                <button
                  key={preset.value}
                  type="button"
                  data-selected={isSelected}
                  onClick={() => handlePresetClick(preset.value)}
                  className={`w-full rounded-lg px-3 py-2 text-left text-sm font-bold transition ${
                    isSelected
                      ? 'bg-[#223f7a] text-white'
                      : 'text-slate-700 hover:bg-slate-100'
                  }`}
                >
                  {preset.label}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
