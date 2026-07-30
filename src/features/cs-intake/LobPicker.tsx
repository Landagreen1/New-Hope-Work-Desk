'use client';

import { Anchor, Building2, Car, ClipboardCheck, Home, Key, Ship, Truck, UserRound } from 'lucide-react';
import type { CsIntakeLob } from './api';

export type ExtendedLob = CsIntakeLob | 'trucking' | 'commercial_gl' | 'homeowners' | 'non_owners' | 'motorcycle' | 'boat' | 'trailer' | 'renters';

interface LobOption {
  value: ExtendedLob;
  label: string;
  description: string;
  icon: React.ReactNode;
  route: 'personal' | 'commercial';
}

const LOB_OPTIONS: LobOption[] = [
  {
    value: 'personal_auto',
    label: 'Personal Auto',
    description: 'Cars, motorcycles, personal vehicles',
    icon: <Car className="h-7 w-7" />,
    route: 'personal',
  },
  {
    value: 'commercial_auto',
    label: 'Commercial Auto',
    description: 'Business vehicles, fleet auto coverage',
    icon: <Car className="h-7 w-7" />,
    route: 'personal',
  },
  {
    value: 'trucking',
    label: 'Trucking',
    description: 'DOT, MC, motor carrier, long-haul',
    icon: <Truck className="h-7 w-7" />,
    route: 'commercial',
  },
  {
    value: 'commercial_gl',
    label: 'Commercial (GL, WC)',
    description: 'General liability, workers comp, BOP, umbrella',
    icon: <Building2 className="h-7 w-7" />,
    route: 'commercial',
  },
  {
    value: 'homeowners',
    label: 'Homeowners',
    description: 'Property, dwelling, homeowners coverage',
    icon: <Home className="h-7 w-7" />,
    route: 'commercial',
  },
  {
    value: 'non_owners',
    label: 'Non-Owners',
    description: 'SR-22 filing, non-owner liability',
    icon: <ClipboardCheck className="h-7 w-7" />,
    route: 'personal',
  },
  {
    value: 'motorcycle',
    label: 'Motorcycle',
    description: 'Motorcycles, scooters, ATVs',
    icon: <Car className="h-7 w-7" />,
    route: 'personal',
  },
  {
    value: 'boat',
    label: 'Boat / Watercraft',
    description: 'Boats, jet skis, watercraft coverage',
    icon: <Ship className="h-7 w-7" />,
    route: 'personal',
  },
  {
    value: 'trailer',
    label: 'Home / Trailer',
    description: 'Mobile homes, travel trailers, RVs',
    icon: <Home className="h-7 w-7" />,
    route: 'personal',
  },
  {
    value: 'renters',
    label: 'Renters',
    description: 'Renters insurance, personal property',
    icon: <Key className="h-7 w-7" />,
    route: 'personal',
  },
];

interface LobPickerProps {
  selected: ExtendedLob | null;
  onSelect: (lob: ExtendedLob) => void;
  disabled?: boolean;
}

export default function LobPicker({ selected, onSelect, disabled }: LobPickerProps) {
  return (
    <div className="space-y-4">
      <div className="text-center">
        <h2 className="text-xl font-black text-slate-950">What type of coverage?</h2>
        <p className="mt-1 text-sm font-semibold text-slate-500">
          Select the customer type to load the right form
        </p>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {LOB_OPTIONS.map((option) => {
          const isSelected = selected === option.value;
          return (
            <button
              key={option.value}
              type="button"
              disabled={disabled}
              onClick={() => onSelect(option.value)}
              className={[
                'group relative flex flex-col items-center gap-2 rounded-2xl border-2 px-5 py-6 text-center transition',
                isSelected
                  ? 'border-[#223f7a] bg-[#eef3fb] ring-4 ring-[#eef3fb]'
                  : 'border-slate-200 bg-white hover:border-[#7890bc] hover:bg-[#f8faff]',
                disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer',
              ].join(' ')}
            >
              <div
                className={[
                  'grid h-14 w-14 place-items-center rounded-2xl transition',
                  isSelected
                    ? 'bg-[#223f7a] text-white'
                    : 'bg-slate-100 text-slate-600 group-hover:bg-[#dce6f5] group-hover:text-[#223f7a]',
                ].join(' ')}
              >
                {option.icon}
              </div>
              <div>
                <p className="text-sm font-black text-slate-900">{option.label}</p>
                <p className="mt-0.5 text-xs font-semibold text-slate-500">{option.description}</p>
              </div>
              <span
                className={[
                  'absolute right-3 top-3 rounded-full px-2 py-0.5 text-[10px] font-black uppercase tracking-wider',
                  option.route === 'commercial'
                    ? 'bg-amber-100 text-amber-700'
                    : 'bg-blue-100 text-blue-700',
                ].join(' ')}
              >
                {option.route === 'commercial' ? 'Commercial' : 'Personal'}
              </span>
            </button>
          );
        })}
      </div>

      {selected && (
        <p className="text-center text-xs font-bold text-slate-400">
          This intake will route to the{' '}
          <span className="font-black text-slate-600">
            {LOB_OPTIONS.find((o) => o.value === selected)?.route === 'commercial'
              ? 'Commercial Board'
              : 'Personal Sales Queue'}
          </span>
        </p>
      )}
    </div>
  );
}

/** Helper to check if a LOB routes to commercial board */
export function isCommercialRoute(lob: ExtendedLob | null): boolean {
  return lob === 'homeowners' || lob === 'trucking' || lob === 'commercial_gl';
}

/** Helper to check if a LOB routes to personal sales queue */
export function isPersonalRoute(lob: ExtendedLob | null): boolean {
  return lob === 'personal_auto' || lob === 'commercial_auto' || lob === 'non_owners' || lob === 'motorcycle' || lob === 'boat' || lob === 'trailer' || lob === 'renters';
}
