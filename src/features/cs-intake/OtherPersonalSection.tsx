'use client';

import { Anchor, Car, Home, Key } from 'lucide-react';
import { ui } from '../nhwd-shared/ui';
import type { ExtendedLob } from './LobPicker';

export interface OtherPersonalData {
  // Motorcycle
  moto_year: string;
  moto_make: string;
  moto_model: string;
  moto_vin: string;
  moto_cc: string;
  moto_type: string; // sport, cruiser, touring, scooter, atv, other
  // Boat
  boat_year: string;
  boat_make: string;
  boat_model: string;
  boat_hin: string; // hull identification number
  boat_length: string;
  boat_type: string; // powerboat, sailboat, jet_ski, pontoon, other
  boat_hp: string; // horsepower
  boat_value: string;
  boat_trailer_included: boolean;
  // Trailer / Mobile Home
  trailer_year: string;
  trailer_make: string;
  trailer_model: string;
  trailer_vin: string;
  trailer_length: string;
  trailer_type: string; // mobile_home, travel_trailer, rv, fifth_wheel, other
  trailer_value: string;
  trailer_park_name: string;
  trailer_lot_number: string;
  // Renters
  renters_property_address: string;
  renters_city: string;
  renters_state: string;
  renters_zip: string;
  renters_unit: string;
  renters_landlord_name: string;
  renters_personal_property_value: string;
  renters_liability_limit: string;
  renters_move_in_date: string;
}

interface Props {
  lob: ExtendedLob;
  data: OtherPersonalData;
  onChange: (patch: Partial<OtherPersonalData>) => void;
  disabled?: boolean;
}

function Field({ label, required, children, hint }: { label: string; required?: boolean; children: React.ReactNode; hint?: string }) {
  return (
    <label className="block">
      <span className={ui.label}>{label}{required ? ' *' : ''}</span>
      {children}
      {hint && <span className="mt-1.5 block text-xs font-semibold text-slate-400">{hint}</span>}
    </label>
  );
}

function MotorcycleFields({ data, onChange, disabled }: Omit<Props, 'lob'>) {
  return (
    <section className={ui.card}>
      <div className={ui.cardHeader}>
        <div className="flex items-start gap-3">
          <div className="grid h-10 w-10 shrink-0 place-items-center rounded-2xl bg-[#eef3fb] text-[#223f7a]">
            <Car className="h-5 w-5" />
          </div>
          <div>
            <h3 className="text-lg font-black text-slate-950">Motorcycle / ATV Details</h3>
            <p className="mt-1 text-sm font-semibold text-slate-500">Vehicle information for the motorcycle or ATV to be insured</p>
          </div>
        </div>
      </div>
      <div className={ui.cardPad}>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Field label="Year" required>
            <input type="text" className={ui.input} value={data.moto_year} onChange={(e) => onChange({ moto_year: e.target.value })} placeholder="e.g. 2022" disabled={disabled} />
          </Field>
          <Field label="Make" required>
            <input type="text" className={ui.input} value={data.moto_make} onChange={(e) => onChange({ moto_make: e.target.value })} placeholder="e.g. Honda, Harley-Davidson" disabled={disabled} />
          </Field>
          <Field label="Model" required>
            <input type="text" className={ui.input} value={data.moto_model} onChange={(e) => onChange({ moto_model: e.target.value })} placeholder="e.g. CBR600RR" disabled={disabled} />
          </Field>
          <Field label="VIN" hint="17 characters">
            <input type="text" className={ui.input} value={data.moto_vin} onChange={(e) => onChange({ moto_vin: e.target.value.toUpperCase() })} placeholder="Vehicle ID number" maxLength={17} disabled={disabled} />
          </Field>
          <Field label="Engine CC">
            <input type="text" className={ui.input} value={data.moto_cc} onChange={(e) => onChange({ moto_cc: e.target.value })} placeholder="e.g. 600" disabled={disabled} />
          </Field>
          <Field label="Type">
            <select className={ui.select} value={data.moto_type} onChange={(e) => onChange({ moto_type: e.target.value })} disabled={disabled}>
              <option value="">Select type</option>
              <option value="sport">Sport</option>
              <option value="cruiser">Cruiser</option>
              <option value="touring">Touring</option>
              <option value="standard">Standard</option>
              <option value="scooter">Scooter</option>
              <option value="atv">ATV / UTV</option>
              <option value="other">Other</option>
            </select>
          </Field>
        </div>
      </div>
    </section>
  );
}

function BoatFields({ data, onChange, disabled }: Omit<Props, 'lob'>) {
  return (
    <section className={ui.card}>
      <div className={ui.cardHeader}>
        <div className="flex items-start gap-3">
          <div className="grid h-10 w-10 shrink-0 place-items-center rounded-2xl bg-[#eef3fb] text-[#223f7a]">
            <Anchor className="h-5 w-5" />
          </div>
          <div>
            <h3 className="text-lg font-black text-slate-950">Boat / Watercraft Details</h3>
            <p className="mt-1 text-sm font-semibold text-slate-500">Information about the watercraft to be insured</p>
          </div>
        </div>
      </div>
      <div className={ui.cardPad}>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Field label="Year" required>
            <input type="text" className={ui.input} value={data.boat_year} onChange={(e) => onChange({ boat_year: e.target.value })} placeholder="e.g. 2020" disabled={disabled} />
          </Field>
          <Field label="Make" required>
            <input type="text" className={ui.input} value={data.boat_make} onChange={(e) => onChange({ boat_make: e.target.value })} placeholder="e.g. Sea Ray, Yamaha" disabled={disabled} />
          </Field>
          <Field label="Model" required>
            <input type="text" className={ui.input} value={data.boat_model} onChange={(e) => onChange({ boat_model: e.target.value })} placeholder="e.g. Sundancer 320" disabled={disabled} />
          </Field>
          <Field label="HIN" hint="Hull Identification Number">
            <input type="text" className={ui.input} value={data.boat_hin} onChange={(e) => onChange({ boat_hin: e.target.value.toUpperCase() })} placeholder="Hull ID" disabled={disabled} />
          </Field>
          <Field label="Length (ft)">
            <input type="text" className={ui.input} value={data.boat_length} onChange={(e) => onChange({ boat_length: e.target.value })} placeholder="e.g. 32" disabled={disabled} />
          </Field>
          <Field label="Horsepower">
            <input type="text" className={ui.input} value={data.boat_hp} onChange={(e) => onChange({ boat_hp: e.target.value })} placeholder="e.g. 350" disabled={disabled} />
          </Field>
          <Field label="Watercraft type" required>
            <select className={ui.select} value={data.boat_type} onChange={(e) => onChange({ boat_type: e.target.value })} disabled={disabled}>
              <option value="">Select type</option>
              <option value="powerboat">Powerboat</option>
              <option value="sailboat">Sailboat</option>
              <option value="jet_ski">Jet Ski / PWC</option>
              <option value="pontoon">Pontoon</option>
              <option value="fishing">Fishing Boat</option>
              <option value="other">Other</option>
            </select>
          </Field>
          <Field label="Estimated value ($)">
            <input type="text" className={ui.input} value={data.boat_value} onChange={(e) => onChange({ boat_value: e.target.value })} placeholder="e.g. 45000" disabled={disabled} />
          </Field>
          <Field label="Trailer included?">
            <select className={ui.select} value={data.boat_trailer_included ? 'yes' : 'no'} onChange={(e) => onChange({ boat_trailer_included: e.target.value === 'yes' })} disabled={disabled}>
              <option value="no">No</option>
              <option value="yes">Yes</option>
            </select>
          </Field>
        </div>
      </div>
    </section>
  );
}

function TrailerFields({ data, onChange, disabled }: Omit<Props, 'lob'>) {
  return (
    <section className={ui.card}>
      <div className={ui.cardHeader}>
        <div className="flex items-start gap-3">
          <div className="grid h-10 w-10 shrink-0 place-items-center rounded-2xl bg-[#eef3fb] text-[#223f7a]">
            <Home className="h-5 w-5" />
          </div>
          <div>
            <h3 className="text-lg font-black text-slate-950">Home / Trailer Details</h3>
            <p className="mt-1 text-sm font-semibold text-slate-500">Mobile home, travel trailer, or RV information</p>
          </div>
        </div>
      </div>
      <div className={ui.cardPad}>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Field label="Year" required>
            <input type="text" className={ui.input} value={data.trailer_year} onChange={(e) => onChange({ trailer_year: e.target.value })} placeholder="e.g. 2019" disabled={disabled} />
          </Field>
          <Field label="Make" required>
            <input type="text" className={ui.input} value={data.trailer_make} onChange={(e) => onChange({ trailer_make: e.target.value })} placeholder="e.g. Jayco, Winnebago" disabled={disabled} />
          </Field>
          <Field label="Model" required>
            <input type="text" className={ui.input} value={data.trailer_model} onChange={(e) => onChange({ trailer_model: e.target.value })} placeholder="e.g. Jay Flight 28BHS" disabled={disabled} />
          </Field>
          <Field label="VIN">
            <input type="text" className={ui.input} value={data.trailer_vin} onChange={(e) => onChange({ trailer_vin: e.target.value.toUpperCase() })} placeholder="Vehicle ID number" maxLength={17} disabled={disabled} />
          </Field>
          <Field label="Length (ft)">
            <input type="text" className={ui.input} value={data.trailer_length} onChange={(e) => onChange({ trailer_length: e.target.value })} placeholder="e.g. 28" disabled={disabled} />
          </Field>
          <Field label="Type" required>
            <select className={ui.select} value={data.trailer_type} onChange={(e) => onChange({ trailer_type: e.target.value })} disabled={disabled}>
              <option value="">Select type</option>
              <option value="mobile_home">Mobile Home</option>
              <option value="travel_trailer">Travel Trailer</option>
              <option value="rv">RV / Motorhome</option>
              <option value="fifth_wheel">Fifth Wheel</option>
              <option value="other">Other</option>
            </select>
          </Field>
          <Field label="Estimated value ($)">
            <input type="text" className={ui.input} value={data.trailer_value} onChange={(e) => onChange({ trailer_value: e.target.value })} placeholder="e.g. 35000" disabled={disabled} />
          </Field>
          <Field label="Park / Community name">
            <input type="text" className={ui.input} value={data.trailer_park_name} onChange={(e) => onChange({ trailer_park_name: e.target.value })} placeholder="If in a park" disabled={disabled} />
          </Field>
          <Field label="Lot / Space #">
            <input type="text" className={ui.input} value={data.trailer_lot_number} onChange={(e) => onChange({ trailer_lot_number: e.target.value })} placeholder="Lot number" disabled={disabled} />
          </Field>
        </div>
      </div>
    </section>
  );
}

function RentersFields({ data, onChange, disabled }: Omit<Props, 'lob'>) {
  return (
    <section className={ui.card}>
      <div className={ui.cardHeader}>
        <div className="flex items-start gap-3">
          <div className="grid h-10 w-10 shrink-0 place-items-center rounded-2xl bg-[#eef3fb] text-[#223f7a]">
            <Key className="h-5 w-5" />
          </div>
          <div>
            <h3 className="text-lg font-black text-slate-950">Renters Insurance Details</h3>
            <p className="mt-1 text-sm font-semibold text-slate-500">Rental property and coverage information</p>
          </div>
        </div>
      </div>
      <div className={ui.cardPad}>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <div className="lg:col-span-2">
            <Field label="Property address" required>
              <input type="text" className={ui.input} value={data.renters_property_address} onChange={(e) => onChange({ renters_property_address: e.target.value })} placeholder="Street address of rental" disabled={disabled} />
            </Field>
          </div>
          <Field label="Unit / Apt">
            <input type="text" className={ui.input} value={data.renters_unit} onChange={(e) => onChange({ renters_unit: e.target.value })} placeholder="Apt, Suite, Unit" disabled={disabled} />
          </Field>
          <Field label="City" required>
            <input type="text" className={ui.input} value={data.renters_city} onChange={(e) => onChange({ renters_city: e.target.value })} placeholder="City" disabled={disabled} />
          </Field>
          <Field label="State" required>
            <input type="text" className={ui.input} value={data.renters_state} onChange={(e) => onChange({ renters_state: e.target.value })} placeholder="State" disabled={disabled} />
          </Field>
          <Field label="ZIP" required>
            <input type="text" className={ui.input} value={data.renters_zip} onChange={(e) => onChange({ renters_zip: e.target.value })} placeholder="ZIP code" disabled={disabled} />
          </Field>
          <Field label="Landlord name">
            <input type="text" className={ui.input} value={data.renters_landlord_name} onChange={(e) => onChange({ renters_landlord_name: e.target.value })} placeholder="Property owner / management co." disabled={disabled} />
          </Field>
          <Field label="Personal property value ($)">
            <input type="text" className={ui.input} value={data.renters_personal_property_value} onChange={(e) => onChange({ renters_personal_property_value: e.target.value })} placeholder="e.g. 25000" disabled={disabled} />
          </Field>
          <Field label="Liability limit">
            <select className={ui.select} value={data.renters_liability_limit} onChange={(e) => onChange({ renters_liability_limit: e.target.value })} disabled={disabled}>
              <option value="">Select limit</option>
              <option value="100000">$100,000</option>
              <option value="300000">$300,000</option>
              <option value="500000">$500,000</option>
            </select>
          </Field>
          <Field label="Move-in date">
            <input type="date" className={ui.input} value={data.renters_move_in_date} onChange={(e) => onChange({ renters_move_in_date: e.target.value })} disabled={disabled} />
          </Field>
        </div>
      </div>
    </section>
  );
}

export default function OtherPersonalSection({ lob, data, onChange, disabled }: Props) {
  switch (lob) {
    case 'motorcycle':
      return <MotorcycleFields data={data} onChange={onChange} disabled={disabled} />;
    case 'boat':
      return <BoatFields data={data} onChange={onChange} disabled={disabled} />;
    case 'trailer':
      return <TrailerFields data={data} onChange={onChange} disabled={disabled} />;
    case 'renters':
      return <RentersFields data={data} onChange={onChange} disabled={disabled} />;
    default:
      return null;
  }
}
