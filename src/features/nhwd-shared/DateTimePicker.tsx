'use client';

import DatePicker from './DatePicker';
import TimePicker from './TimePicker';

interface DateTimePickerProps {
  /** ISO datetime-local format: YYYY-MM-DDTHH:mm */
  value: string;
  onChange: (value: string) => void;
  min?: string;
  disabled?: boolean;
  className?: string;
}

/**
 * Combined DatePicker + TimePicker that emits a datetime-local string (YYYY-MM-DDTHH:mm).
 * Displays side by side: date on left, time on right.
 */
export default function DateTimePicker({ value, onChange, min, disabled = false, className = '' }: DateTimePickerProps) {
  // Split YYYY-MM-DDTHH:mm into date and time parts
  const [datePart, timePart] = (value || '').split('T');
  const dateValue = datePart || '';
  const timeValue = timePart?.slice(0, 5) || '';

  const handleDateChange = (newDate: string) => {
    const t = timeValue || '09:00';
    onChange(`${newDate}T${t}`);
  };

  const handleTimeChange = (newTime: string) => {
    const d = dateValue || new Date().toISOString().split('T')[0];
    onChange(`${d}T${newTime}`);
  };

  const minDate = min ? min.split('T')[0] : undefined;

  return (
    <div className={`grid grid-cols-2 gap-2 ${className}`}>
      <DatePicker
        value={dateValue}
        onChange={handleDateChange}
        min={minDate}
        disabled={disabled}
        placeholder="Date"
      />
      <TimePicker
        value={timeValue}
        onChange={handleTimeChange}
        disabled={disabled}
        placeholder="Time"
      />
    </div>
  );
}
