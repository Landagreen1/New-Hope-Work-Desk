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

const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAY_HEADERS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];

function toDateKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function parseIso(s: string): Date | null {
  if (!s) return null;
  const [y, m, d] = s.split('-').map(Number);
  if (!y || !m || !d) return null;
  return new Date(y, m - 1, d);
}

function toDisplay(value: string): string {
  if (!value) return '';
  const d = parseIso(value);
  if (!d) return value;
  return `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}/${d.getFullYear()}`;
}

function parseTyped(input: string): string | null {
  // Strip all non-numeric
  const cleaned = input.replace(/[^0-9]/g, '');
  let m: number, d: number, y: number;

  if (cleaned.length === 8) {
    m = parseInt(cleaned.slice(0, 2), 10);
    d = parseInt(cleaned.slice(2, 4), 10);
    y = parseInt(cleaned.slice(4, 8), 10);
  } else {
    // Try splitting by / - .
    const parts = input.split(/[/\-\.]/);
    if (parts.length !== 3) return null;
    m = parseInt(parts[0], 10);
    d = parseInt(parts[1], 10);
    y = parseInt(parts[2], 10);
    if (y < 100) y = y > 50 ? 1900 + y : 2000 + y;
  }

  if (m >= 1 && m <= 12 && d >= 1 && d <= 31 && y >= 1900 && y <= 2100) {
    return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }
  return null;
}

export default function DatePicker({ value, onChange, min, max, placeholder = 'MM/DD/YYYY', disabled = false, className = '' }: DatePickerProps) {
  const [open, setOpen] = useState(false);
  const [textValue, setTextValue] = useState(() => toDisplay(value));
  const [viewMonth, setViewMonth] = useState(() => {
    const d = parseIso(value);
    return d ? new Date(d.getFullYear(), d.getMonth(), 1) : new Date(new Date().getFullYear(), new Date().getMonth(), 1);
  });
  const containerRef = useRef<HTMLDivElement>(null);

  // Sync text when value changes externally
  useEffect(() => {
    setTextValue(toDisplay(value));
  }, [value]);

  // Sync calendar view when value changes
  useEffect(() => {
    const d = parseIso(value);
    if (d) setViewMonth(new Date(d.getFullYear(), d.getMonth(), 1));
  }, [value]);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const prevMonth = useCallback(() => setViewMonth(prev => new Date(prev.getFullYear(), prev.getMonth() - 1, 1)), []);
  const nextMonth = useCallback(() => setViewMonth(prev => new Date(prev.getFullYear(), prev.getMonth() + 1, 1)), []);
  const today = useMemo(() => toDateKey(new Date()), []);

  const yearOptions = useMemo(() => {
    const current = new Date().getFullYear();
    const years: number[] = [];
    for (let y = current + 10; y >= current - 100; y--) years.push(y);
    return years;
  }, []);

  const calendarDays = useMemo(() => {
    const firstDay = new Date(viewMonth);
    const lastDay = new Date(viewMonth.getFullYear(), viewMonth.getMonth() + 1, 0);
    const startDay = new Date(firstDay);
    const dow = startDay.getDay();
    startDay.setDate(startDay.getDate() - (dow === 0 ? 6 : dow - 1));
    const endDay = new Date(lastDay);
    const endDow = endDay.getDay();
    endDay.setDate(endDay.getDate() + (endDow === 0 ? 0 : 7 - endDow));
    const days: Date[] = [];
    const current = new Date(startDay);
    while (current <= endDay) { days.push(new Date(current)); current.setDate(current.getDate() + 1); }
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

  const commitText = () => {
    if (!textValue.trim()) { onChange(''); return; }
    const parsed = parseTyped(textValue);
    if (parsed && !isDisabled(parsed)) {
      onChange(parsed);
    } else {
      // Reset to current value on invalid input
      setTextValue(toDisplay(value));
    }
  };

  return (
    <div ref={containerRef} className={`relative ${className}`}>
      {/* Combined input: type date or click calendar icon */}
      <div className={`flex items-center rounded-xl border transition ${
        open ? 'border-[#223f7a] ring-4 ring-[#eef3fb]' : 'border-slate-200 hover:border-slate-300'
      } ${disabled ? 'cursor-not-allowed bg-slate-50 opacity-60' : 'bg-white'}`}>
        <input
          type="text"
          value={textValue}
          onChange={(e) => setTextValue(e.target.value)}
          onBlur={commitText}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { commitText(); e.preventDefault(); }
          }}
          onFocus={() => setOpen(false)}
          placeholder={placeholder}
          disabled={disabled}
          className="flex-1 rounded-l-xl border-0 bg-transparent px-3.5 py-2.5 text-sm font-semibold text-slate-900 outline-none placeholder:text-slate-400"
        />
        <button
          type="button"
          onClick={() => !disabled && setOpen(!open)}
          disabled={disabled}
          className="grid h-full w-10 shrink-0 place-items-center rounded-r-xl text-[#223f7a] hover:bg-[#eef3fb] transition"
          title="Open calendar"
        >
          <Calendar className="h-4 w-4" />
        </button>
      </div>

      {/* Calendar Dropdown */}
      {open && (
        <div className="absolute right-0 top-full z-50 mt-2 w-[300px] rounded-2xl border border-slate-200 bg-white p-4 shadow-xl">
          {/* Month + Year selectors */}
          <div className="flex items-center justify-between mb-3 gap-1">
            <button type="button" onClick={prevMonth} className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-slate-500 hover:bg-slate-100">
              <ChevronLeft className="h-4 w-4" />
            </button>
            <div className="flex items-center gap-1">
              <select
                value={viewMonth.getMonth()}
                onChange={(e) => setViewMonth(new Date(viewMonth.getFullYear(), parseInt(e.target.value), 1))}
                className="rounded-lg border-0 bg-transparent px-1 py-0.5 text-sm font-black text-slate-900 cursor-pointer hover:bg-slate-100 focus:outline-none"
              >
                {MONTH_SHORT.map((m, i) => <option key={i} value={i}>{m}</option>)}
              </select>
              <select
                value={viewMonth.getFullYear()}
                onChange={(e) => setViewMonth(new Date(parseInt(e.target.value), viewMonth.getMonth(), 1))}
                className="rounded-lg border-0 bg-transparent px-1 py-0.5 text-sm font-black text-slate-900 cursor-pointer hover:bg-slate-100 focus:outline-none"
              >
                {yearOptions.map(y => <option key={y} value={y}>{y}</option>)}
              </select>
            </div>
            <button type="button" onClick={nextMonth} className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-slate-500 hover:bg-slate-100">
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>

          {/* Weekday headers */}
          <div className="grid grid-cols-7 mb-1">
            {WEEKDAY_HEADERS.map(day => (
              <div key={day} className="py-1 text-center text-[10px] font-black uppercase tracking-wider text-slate-400">{day}</div>
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
                    isSelected ? 'bg-[#223f7a] text-white shadow-sm'
                    : isToday ? 'bg-[#eef3fb] text-[#223f7a] font-black'
                    : isCurrentMonth
                      ? dayDisabled ? 'text-slate-200 cursor-not-allowed' : 'text-slate-700 hover:bg-slate-100'
                      : dayDisabled ? 'text-slate-200 cursor-not-allowed' : 'text-slate-300 hover:bg-slate-50'
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
              className="text-xs font-black text-[#223f7a] hover:underline disabled:text-slate-300"
            >
              Today
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
