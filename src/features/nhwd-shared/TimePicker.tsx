'use client';

import { Clock } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

interface TimePickerProps {
  value: string; // HH:mm (24-hour)
  onChange: (value: string) => void;
  label?: string;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
}

function to12Hour(h24: number): { hour: number; period: 'AM' | 'PM' } {
  if (h24 === 0) return { hour: 12, period: 'AM' };
  if (h24 < 12) return { hour: h24, period: 'AM' };
  if (h24 === 12) return { hour: 12, period: 'PM' };
  return { hour: h24 - 12, period: 'PM' };
}

function to24Hour(hour: number, period: 'AM' | 'PM'): number {
  if (period === 'AM') return hour === 12 ? 0 : hour;
  return hour === 12 ? 12 : hour + 12;
}

function parseTime(value: string): { hour: number; minute: number; period: 'AM' | 'PM' } {
  const [hStr, mStr] = (value || '09:00').split(':');
  const h24 = parseInt(hStr, 10) || 0;
  const minute = parseInt(mStr, 10) || 0;
  const { hour, period } = to12Hour(h24);
  return { hour, minute, period };
}

const HOURS = [12, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
const MINUTES = [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55];

export default function TimePicker({ value, onChange, placeholder = 'Select time', disabled = false, className = '' }: TimePickerProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const { hour, minute, period } = parseTime(value);

  // Close on click outside
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const emit = (h: number, m: number, p: 'AM' | 'PM') => {
    const h24 = to24Hour(h, p);
    onChange(`${String(h24).padStart(2, '0')}:${String(m).padStart(2, '0')}`);
  };

  const handleHour = (h: number) => emit(h, minute, period);
  const handleMinute = (m: number) => emit(hour, m, period);
  const handlePeriod = (p: 'AM' | 'PM') => emit(hour, minute, p);

  const displayValue = value
    ? `${hour}:${String(minute).padStart(2, '0')} ${period}`
    : '';

  return (
    <div ref={containerRef} className={`relative ${className}`}>
      {/* Trigger */}
      <button
        type="button"
        onClick={() => !disabled && setOpen(!open)}
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
        <div className="absolute left-0 top-full z-50 mt-2 w-[280px] rounded-2xl border border-slate-200 bg-white p-4 shadow-xl animate-in fade-in-0 zoom-in-95">
          {/* AM/PM Toggle */}
          <div className="flex justify-center gap-1 mb-4 rounded-xl bg-slate-100 p-1">
            {(['AM', 'PM'] as const).map(p => (
              <button
                key={p}
                type="button"
                onClick={() => handlePeriod(p)}
                className={`flex-1 rounded-lg py-2 text-sm font-black transition ${
                  period === p
                    ? 'bg-[#223f7a] text-white shadow-sm'
                    : 'text-slate-500 hover:text-slate-800'
                }`}
              >
                {p}
              </button>
            ))}
          </div>

          {/* Hour selection */}
          <div className="mb-3">
            <p className="mb-2 text-[10px] font-black uppercase tracking-wider text-slate-400">Hour</p>
            <div className="grid grid-cols-6 gap-1">
              {HOURS.map(h => (
                <button
                  key={h}
                  type="button"
                  onClick={() => handleHour(h)}
                  className={`grid h-9 place-items-center rounded-lg text-sm font-bold transition ${
                    hour === h
                      ? 'bg-[#223f7a] text-white shadow-sm'
                      : 'text-slate-700 hover:bg-slate-100'
                  }`}
                >
                  {h}
                </button>
              ))}
            </div>
          </div>

          {/* Minute selection */}
          <div>
            <p className="mb-2 text-[10px] font-black uppercase tracking-wider text-slate-400">Minute</p>
            <div className="grid grid-cols-6 gap-1">
              {MINUTES.map(m => (
                <button
                  key={m}
                  type="button"
                  onClick={() => handleMinute(m)}
                  className={`grid h-9 place-items-center rounded-lg text-sm font-bold transition ${
                    minute === m
                      ? 'bg-[#223f7a] text-white shadow-sm'
                      : 'text-slate-700 hover:bg-slate-100'
                  }`}
                >
                  :{String(m).padStart(2, '0')}
                </button>
              ))}
            </div>
          </div>

          {/* Current value display */}
          <div className="mt-4 flex items-center justify-center border-t border-slate-100 pt-3">
            <p className="text-lg font-black text-[#223f7a]">
              {hour}:{String(minute).padStart(2, '0')} {period}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
