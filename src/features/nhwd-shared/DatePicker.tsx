'use client';

import { Calendar, ChevronLeft, ChevronRight } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

interface DatePickerProps {
  value: string; // YYYY-MM-DD
  onChange: (value: string) => void;
  min?: string; // YYYY-MM-DD
  max?: string; // YYYY-MM-DD
  label?: string;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
}

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const WEEKDAY_HEADERS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];

function toDateKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function parseDate(s: string): Date | null {
  if (!s) return null;
  const [y, m, d] = s.split('-').map(Number);
  if (!y || !m || !d) return null;
  return new Date(y, m - 1, d);
}

export default function DatePicker({ value, onChange, min, max, label, placeholder = 'Select date', disabled = false, className = '' }: DatePickerProps) {
  const [open, setOpen] = useState(false);
  const [viewMonth, setViewMonth] = useState(() => {
    const d = parseDate(value);
    return d ? new Date(d.getFullYear(), d.getMonth(), 1) : new Date(new Date().getFullYear(), new Date().getMonth(), 1);
  });
  const containerRef = useRef<HTMLDivElement>(null);

  // Close on click outside
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  // Sync view month when value changes externally
  useEffect(() => {
    const d = parseDate(value);
    if (d) setViewMonth(new Date(d.getFullYear(), d.getMonth(), 1));
  }, [value]);

  const prevMonth = useCallback(() => setViewMonth(prev => new Date(prev.getFullYear(), prev.getMonth() - 1, 1)), []);
  const nextMonth = useCallback(() => setViewMonth(prev => new Date(prev.getFullYear(), prev.getMonth() + 1, 1)), []);

  const today = useMemo(() => toDateKey(new Date()), []);

  const calendarDays = useMemo(() => {
    const firstDay = new Date(viewMonth);
    const lastDay = new Date(viewMonth.getFullYear(), viewMonth.getMonth() + 1, 0);

    // Start from Monday of the week containing the 1st
    const startDay = new Date(firstDay);
    const dow = startDay.getDay();
    const diff = dow === 0 ? 6 : dow - 1;
    startDay.setDate(startDay.getDate() - diff);

    // End on Sunday of the week containing the last day
    const endDay = new Date(lastDay);
    const endDow = endDay.getDay();
    const endDiff = endDow === 0 ? 0 : 7 - endDow;
    endDay.setDate(endDay.getDate() + endDiff);

    const days: Date[] = [];
    const current = new Date(startDay);
    while (current <= endDay) {
      days.push(new Date(current));
      current.setDate(current.getDate() + 1);
    }
    return days;
  }, [viewMonth]);

  const isDisabled = useCallback((dateStr: string) => {
    if (min && dateStr < min) return true;
    if (max && dateStr > max) return true;
    return false;
  }, [min, max]);

  const handleSelect = (dateStr: string) => {
    if (isDisabled(dateStr)) return;
    onChange(dateStr);
    setOpen(false);
  };

  const displayValue = useMemo(() => {
    if (!value) return '';
    const d = parseDate(value);
    if (!d) return value;
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }, [value]);

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
        <Calendar className="h-4 w-4 shrink-0 text-[#223f7a]" />
        <span className={displayValue ? 'text-slate-900' : 'text-slate-400'}>
          {displayValue || placeholder}
        </span>
      </button>

      {/* Dropdown */}
      {open && (
        <div className="absolute left-0 top-full z-50 mt-2 w-[300px] rounded-2xl border border-slate-200 bg-white p-4 shadow-xl animate-in fade-in-0 zoom-in-95">
          {/* Month navigation */}
          <div className="flex items-center justify-between mb-3">
            <button type="button" onClick={prevMonth} className="grid h-8 w-8 place-items-center rounded-lg text-slate-500 transition hover:bg-slate-100 hover:text-slate-800">
              <ChevronLeft className="h-4 w-4" />
            </button>
            <p className="text-sm font-black text-slate-900">
              {MONTH_NAMES[viewMonth.getMonth()]} {viewMonth.getFullYear()}
            </p>
            <button type="button" onClick={nextMonth} className="grid h-8 w-8 place-items-center rounded-lg text-slate-500 transition hover:bg-slate-100 hover:text-slate-800">
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>

          {/* Weekday headers */}
          <div className="grid grid-cols-7 mb-1">
            {WEEKDAY_HEADERS.map(day => (
              <div key={day} className="py-1 text-center text-[10px] font-black uppercase tracking-wider text-slate-400">
                {day}
              </div>
            ))}
          </div>

          {/* Day grid */}
          <div className="grid grid-cols-7 gap-0.5">
            {calendarDays.map(date => {
              const dateStr = toDateKey(date);
              const isCurrentMonth = date.getMonth() === viewMonth.getMonth();
              const isToday = dateStr === today;
              const isSelected = dateStr === value;
              const dayDisabled = isDisabled(dateStr);

              return (
                <button
                  key={dateStr}
                  type="button"
                  onClick={() => handleSelect(dateStr)}
                  disabled={dayDisabled}
                  className={`grid h-9 w-full place-items-center rounded-lg text-sm font-bold transition ${
                    isSelected
                      ? 'bg-[#223f7a] text-white shadow-sm'
                      : isToday
                        ? 'bg-[#eef3fb] text-[#223f7a] font-black'
                        : isCurrentMonth
                          ? dayDisabled
                            ? 'text-slate-200 cursor-not-allowed'
                            : 'text-slate-700 hover:bg-slate-100'
                          : dayDisabled
                            ? 'text-slate-200 cursor-not-allowed'
                            : 'text-slate-300 hover:bg-slate-50'
                  }`}
                >
                  {date.getDate()}
                </button>
              );
            })}
          </div>

          {/* Today shortcut */}
          <div className="mt-3 flex justify-center border-t border-slate-100 pt-3">
            <button
              type="button"
              onClick={() => { onChange(today); setOpen(false); }}
              disabled={isDisabled(today)}
              className="text-xs font-black text-[#223f7a] hover:underline disabled:text-slate-300 disabled:no-underline"
            >
              Today
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
