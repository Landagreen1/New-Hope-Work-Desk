'use client';

import { useState } from 'react';
import { Search } from 'lucide-react';
import { ui } from '../nhwd-shared/ui';

interface VinResult {
  year: number | null;
  make: string | null;
  model: string | null;
  bodyClass: string | null;
  error: string | null;
}

/**
 * Decodes a VIN using the NHTSA vPIC API (free, no key required).
 * Returns year, make, model, and body class.
 */
async function decodeVin(vin: string): Promise<VinResult> {
  const cleanVin = vin.trim().toUpperCase();
  if (cleanVin.length !== 17) {
    return { year: null, make: null, model: null, bodyClass: null, error: 'VIN must be exactly 17 characters.' };
  }

  try {
    const response = await fetch(
      `https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVinValues/${cleanVin}?format=json`
    );
    if (!response.ok) throw new Error('NHTSA API unavailable');
    const data = await response.json();
    const result = data.Results?.[0];

    if (!result) {
      return { year: null, make: null, model: null, bodyClass: null, error: 'No data returned for this VIN.' };
    }

    // NHTSA returns error codes: 0 = no error, others indicate issues
    const errorCode = result.ErrorCode;
    const hasErrors = errorCode && errorCode !== '0' && !errorCode.includes('0');

    const year = result.ModelYear ? parseInt(result.ModelYear, 10) : null;
    const make = result.Make || null;
    const model = result.Model || null;
    const bodyClass = result.BodyClass || null;

    if (!make && !model && !year) {
      return { year: null, make: null, model: null, bodyClass: null, error: 'VIN not recognized. Verify and re-enter.' };
    }

    return {
      year: isNaN(year as number) ? null : year,
      make,
      model,
      bodyClass,
      error: hasErrors ? 'Partial match — some fields may be inaccurate.' : null,
    };
  } catch {
    return { year: null, make: null, model: null, bodyClass: null, error: 'Unable to reach VIN decoder. Enter vehicle info manually.' };
  }
}

interface VinDecoderProps {
  vin: string;
  disabled?: boolean;
  onVinChange: (vin: string) => void;
  onDecoded: (result: { year: number | null; make: string | null; model: string | null }) => void;
}

export default function VinDecoder({ vin, disabled, onVinChange, onDecoded }: VinDecoderProps) {
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<VinResult | null>(null);

  async function handleDecode() {
    if (!vin || vin.trim().length < 17) return;
    setLoading(true);
    setResult(null);
    try {
      const decoded = await decodeVin(vin);
      setResult(decoded);
      if (decoded.year || decoded.make || decoded.model) {
        onDecoded({ year: decoded.year, make: decoded.make, model: decoded.model });
      }
    } finally {
      setLoading(false);
    }
  }

  const hasError = result?.error && !result.year && !result.make && !result.model;

  return (
    <div>
      <label className="block">
        <span className={ui.label}>VIN *</span>
        <div className="flex gap-2">
          <input
            className={`${ui.input} flex-1 uppercase ${hasError ? 'border-red-400 bg-red-50 text-red-900' : ''}`}
            disabled={disabled}
            value={vin}
            maxLength={17}
            placeholder="Enter 17-character VIN"
            onChange={(event) => {
              onVinChange(event.target.value.toUpperCase());
              setResult(null);
            }}
            onBlur={() => { if (vin.length === 17 && !result) void handleDecode(); }}
          />
          <button
            type="button"
            className={ui.btnSecondary}
            disabled={disabled || loading || vin.length < 17}
            onClick={() => void handleDecode()}
            title="Decode VIN"
          >
            {loading ? (
              <span className="h-4 w-4 animate-spin rounded-full border-2 border-slate-300 border-t-[#223f7a]" />
            ) : (
              <Search className="h-4 w-4" />
            )}
          </button>
        </div>
      </label>

      {/* Result feedback */}
      {result && !hasError && (
        <div className="mt-2 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs font-bold text-emerald-800">
          Decoded: {result.year} {result.make} {result.model}
          {result.bodyClass ? ` (${result.bodyClass})` : ''}
          {result.error ? <span className="ml-2 text-amber-700">{result.error}</span> : null}
        </div>
      )}
      {hasError && (
        <div className="mt-2 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-xs font-bold text-red-800">
          {result.error}
        </div>
      )}
    </div>
  );
}
