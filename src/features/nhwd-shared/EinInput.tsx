'use client';

import { useCallback } from 'react';
import { ui } from './ui';

interface EinInputProps {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}

function formatEin(raw: string): string {
  const digits = raw.replace(/\D/g, '').slice(0, 9);
  if (digits.length <= 2) return digits;
  return digits.slice(0, 2) + '-' + digits.slice(2);
}

function stripEin(formatted: string): string {
  return formatted.replace(/\D/g, '').slice(0, 9);
}

export default function EinInput({ value, onChange, disabled = false }: EinInputProps) {
  const handleChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const raw = stripEin(e.target.value);
    onChange(formatEin(raw));
  }, [onChange]);

  return (
    <input
      type="text"
      className={ui.input}
      value={value ? formatEin(stripEin(value)) : ''}
      onChange={handleChange}
      placeholder="XX-XXXXXXX"
      maxLength={10} // 2 digits + dash + 7 digits
      disabled={disabled}
    />
  );
}
