'use client';

import { useCallback, useState } from 'react';
import { ui } from './ui';

interface DollarInputProps {
  value: number | null;
  onChange: (value: number | null) => void;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
}

function formatDollar(n: number | null): string {
  if (n === null || n === undefined) return '';
  return '$' + n.toLocaleString('en-US');
}

function parseRaw(input: string): number | null {
  const cleaned = input.replace(/[$,\s]/g, '');
  if (!cleaned) return null;
  const n = Number(cleaned);
  return isNaN(n) ? null : Math.round(n);
}

export default function DollarInput({ value, onChange, placeholder = '$0', disabled = false, className = '' }: DollarInputProps) {
  const [focused, setFocused] = useState(false);
  const [rawText, setRawText] = useState('');

  const handleFocus = useCallback(() => {
    setFocused(true);
    // Show raw number for easy editing
    setRawText(value !== null && value !== undefined ? String(value) : '');
  }, [value]);

  const handleBlur = useCallback(() => {
    setFocused(false);
    const parsed = parseRaw(rawText);
    onChange(parsed);
  }, [rawText, onChange]);

  const handleChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setRawText(e.target.value);
  }, []);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      (e.target as HTMLInputElement).blur();
    }
  }, []);

  return (
    <input
      type="text"
      inputMode="numeric"
      className={`${ui.input} ${className}`}
      value={focused ? rawText : formatDollar(value)}
      onChange={handleChange}
      onFocus={handleFocus}
      onBlur={handleBlur}
      onKeyDown={handleKeyDown}
      placeholder={placeholder}
      disabled={disabled}
    />
  );
}
