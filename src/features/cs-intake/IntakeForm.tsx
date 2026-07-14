// src/features/cs-intake/IntakeForm.tsx
// Structured intake form. Field-level by design (HawkSoft-mappable):
// insured, contact, address, drivers, vehicles, current + requested coverage.
'use client';

import { useEffect, useState } from 'react';
import { ui } from '../nhwd-shared/ui';
import {
  CsIntakeDriver, CsIntakeLob, CsIntakePriority, CsIntakeSubmission,
  CsIntakeVehicle, Dealer, DealerSalesperson,
  listDealers, listSalespeople, saveDraft, submitIntake,
} from './api';

const LOBS: CsIntakeLob[] = [
  'auto', 'motorcycle', 'home', 'renters', 'commercial_auto', 'general_liability', 'other',
];
const PRIORITIES: CsIntakePriority[] = ['normal', 'high', 'urgent'];
const US_STATES = ['AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY'];

const emptyDriver = (): CsIntakeDriver => ({
  position: 1, first_name: '', last_name: '', dob: null, relationship: 'self',
  license_number: null, license_state: null, license_status: 'valid',
  years_licensed: null, sr22_required: false,
});
const emptyVehicle = (): CsIntakeVehicle => ({
  position: 1, year: null, make: null, model: null, vin: null, vin_pending: false,
  ownership: 'owned', lienholder: null, usage: 'commute', annual_mileage: null,
  garaging_zip: null,
});

interface Props {
  profileId: string;
  initial?: { submission: CsIntakeSubmission; drivers: CsIntakeDriver[]; vehicles: CsIntakeVehicle[] };
  readOnly?: boolean;
  onDone: () => void;
}

export default function IntakeForm({ profileId, initial, readOnly, onDone }: Props) {
  const [s, setS] = useState<Partial<CsIntakeSubmission>>(
    initial?.submission ?? {
      priority: 'normal', line_of_business: 'auto', mailing_same_as_addr: true,
      insured_first_name: '', insured_last_name: '',
    },
  );
  const [drivers, setDrivers] = useState<CsIntakeDriver[]>(
    initial?.drivers?.length ? initial.drivers : [emptyDriver()],
  );
  const [vehicles, setVehicles] = useState<CsIntakeVehicle[]>(
    initial?.vehicles?.length ? initial.vehicles : [emptyVehicle()],
  );
  const [dealers, setDealers] = useState<Dealer[]>([]);
  const [salespeople, setSalespeople] = useState<DealerSalesperson[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => { listDealers().then(setDealers); }, []);
  useEffect(() => {
    if (s.dealer_id) listSalespeople(s.dealer_id).then(setSalespeople);
    else setSalespeople([]);
  }, [s.dealer_id]);

  const isAutoLob = ['auto', 'motorcycle', 'commercial_auto']
    .includes(s.line_of_business ?? 'auto');
  const set = (patch: Partial<CsIntakeSubmission>) => setS((p) => ({ ...p, ...patch }));

  async function handleSave(alsoSubmit: boolean) {
    setBusy(true); setError(null); setNotice(null);
    try {
      const id = await saveDraft(profileId, s, isAutoLob ? drivers : [], isAutoLob ? vehicles : []);
      set({ id });
      if (alsoSubmit) {
        await submitIntake(id);
        setNotice('Intake submitted. Agents were notified.');
        setTimeout(onDone, 900);
      } else {
        setNotice('Draft saved.');
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Something went wrong. The intake was not changed.');
    } finally {
      setBusy(false);
    }
  }

  const dis = readOnly || busy;

  return (
    <div className="space-y-5">
      {s.status === 'returned' && s.return_reason && (
        <div className={ui.error}>Returned by an agent: {s.return_reason}</div>
      )}
      {error && <div className={ui.error}>{error}</div>}
      {notice && <div className={ui.success}>{notice}</div>}

      {/* Routing */}
      <section className={ui.card}>
        <div className={ui.cardHeader}><h3 className={ui.sectionTitle}>Quote details</h3></div>
        <div className={`${ui.cardPad} ${ui.fieldRow}`}>
          <div>
            <label className={ui.label}>Line of business</label>
            <select className={ui.select} disabled={dis} value={s.line_of_business ?? 'auto'}
              onChange={(e) => set({ line_of_business: e.target.value as CsIntakeLob })}>
              {LOBS.map((l) => <option key={l} value={l}>{l.replace(/_/g, ' ')}</option>)}
            </select>
          </div>
          <div>
            <label className={ui.label}>Priority</label>
            <select className={ui.select} disabled={dis} value={s.priority ?? 'normal'}
              onChange={(e) => set({ priority: e.target.value as CsIntakePriority })}>
              {PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
          </div>
          <div>
            <label className={ui.label}>Dealer / source</label>
            <select className={ui.select} disabled={dis} value={s.dealer_id ?? ''}
              onChange={(e) => set({ dealer_id: e.target.value || null, salesperson_id: null })}>
              <option value="">— none —</option>
              {dealers.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
          </div>
          <div>
            <label className={ui.label}>Salesperson</label>
            <select className={ui.select} disabled={dis || !s.dealer_id} value={s.salesperson_id ?? ''}
              onChange={(e) => set({ salesperson_id: e.target.value || null })}>
              <option value="">— none —</option>
              {salespeople.map((sp) => <option key={sp.id} value={sp.id}>{sp.name}</option>)}
            </select>
          </div>
        </div>
      </section>

      {/* Insured + contact */}
      <section className={ui.card}>
        <div className={ui.cardHeader}><h3 className={ui.sectionTitle}>Insured &amp; contact</h3></div>
        <div className={`${ui.cardPad} ${ui.fieldRow}`}>
          <div><label className={ui.label}>First name *</label>
            <input className={ui.input} disabled={dis} value={s.insured_first_name ?? ''}
              onChange={(e) => set({ insured_first_name: e.target.value })} /></div>
          <div><label className={ui.label}>Last name *</label>
            <input className={ui.input} disabled={dis} value={s.insured_last_name ?? ''}
              onChange={(e) => set({ insured_last_name: e.target.value })} /></div>
          <div><label className={ui.label}>Date of birth *</label>
            <input type="date" className={ui.input} disabled={dis} value={s.insured_dob ?? ''}
              onChange={(e) => set({ insured_dob: e.target.value || null })} /></div>
          <div><label className={ui.label}>Primary phone *</label>
            <input className={ui.input} disabled={dis} value={s.insured_phone_primary ?? ''}
              onChange={(e) => set({ insured_phone_primary: e.target.value })} /></div>
          <div><label className={ui.label}>Alternate phone</label>
            <input className={ui.input} disabled={dis} value={s.insured_phone_alt ?? ''}
              onChange={(e) => set({ insured_phone_alt: e.target.value || null })} /></div>
          <div><label className={ui.label}>Email</label>
            <input className={ui.input} disabled={dis} value={s.insured_email ?? ''}
              onChange={(e) => set({ insured_email: e.target.value || null })} /></div>
          <div><label className={ui.label}>Preferred language</label>
            <select className={ui.select} disabled={dis} value={s.preferred_language ?? ''}
              onChange={(e) => set({ preferred_language: e.target.value || null })}>
              <option value="">—</option><option value="spanish">Spanish</option>
              <option value="english">English</option><option value="other">Other</option>
            </select></div>
          <div><label className={ui.label}>Preferred contact</label>
            <select className={ui.select} disabled={dis} value={s.preferred_contact ?? ''}
              onChange={(e) => set({ preferred_contact: e.target.value || null })}>
              <option value="">—</option><option value="call">Call</option>
              <option value="sms">Text</option><option value="whatsapp">WhatsApp</option>
              <option value="email">Email</option>
            </select></div>
        </div>
      </section>

      {/* Address */}
      <section className={ui.card}>
        <div className={ui.cardHeader}><h3 className={ui.sectionTitle}>Address</h3></div>
        <div className={`${ui.cardPad} ${ui.fieldRow}`}>
          <div className="sm:col-span-2"><label className={ui.label}>Street *</label>
            <input className={ui.input} disabled={dis} value={s.addr_street ?? ''}
              onChange={(e) => set({ addr_street: e.target.value })} /></div>
          <div><label className={ui.label}>Unit / Apt</label>
            <input className={ui.input} disabled={dis} value={s.addr_unit ?? ''}
              onChange={(e) => set({ addr_unit: e.target.value || null })} /></div>
          <div><label className={ui.label}>City *</label>
            <input className={ui.input} disabled={dis} value={s.addr_city ?? ''}
              onChange={(e) => set({ addr_city: e.target.value })} /></div>
          <div><label className={ui.label}>State *</label>
            <select className={ui.select} disabled={dis} value={s.addr_state ?? ''}
              onChange={(e) => set({ addr_state: e.target.value })}>
              <option value="">—</option>
              {US_STATES.map((st) => <option key={st} value={st}>{st}</option>)}
            </select></div>
          <div><label className={ui.label}>ZIP *</label>
            <input className={ui.input} disabled={dis} value={s.addr_zip ?? ''}
              onChange={(e) => set({ addr_zip: e.target.value })} /></div>
        </div>
      </section>

      {/* Drivers + vehicles for auto lines */}
      {isAutoLob && (
        <>
          <section className={ui.card}>
            <div className={ui.cardHeader}>
              <h3 className={ui.sectionTitle}>Drivers ({drivers.length})</h3>
              {!readOnly && (
                <button type="button" className={ui.btnSecondary}
                  onClick={() => setDrivers((d) => [...d, { ...emptyDriver(), position: d.length + 1 }])}>
                  Add driver
                </button>
              )}
            </div>
            <div className={`${ui.cardPad} space-y-4`}>
              {drivers.map((d, i) => (
                <div key={i} className="rounded-md border border-slate-200 p-3">
                  <div className="mb-2 flex items-center justify-between">
                    <span className="text-xs font-semibold text-slate-500">Driver {i + 1}</span>
                    {!readOnly && drivers.length > 1 && (
                      <button type="button" className={ui.btnGhost}
                        onClick={() => setDrivers((arr) => arr.filter((_, j) => j !== i))}>
                        Remove
                      </button>
                    )}
                  </div>
                  <div className={ui.fieldRow}>
                    <div><label className={ui.label}>First name</label>
                      <input className={ui.input} disabled={dis} value={d.first_name}
                        onChange={(e) => setDrivers((arr) => arr.map((x, j) => j === i ? { ...x, first_name: e.target.value } : x))} /></div>
                    <div><label className={ui.label}>Last name</label>
                      <input className={ui.input} disabled={dis} value={d.last_name}
                        onChange={(e) => setDrivers((arr) => arr.map((x, j) => j === i ? { ...x, last_name: e.target.value } : x))} /></div>
                    <div><label className={ui.label}>Date of birth</label>
                      <input type="date" className={ui.input} disabled={dis} value={d.dob ?? ''}
                        onChange={(e) => setDrivers((arr) => arr.map((x, j) => j === i ? { ...x, dob: e.target.value || null } : x))} /></div>
                    <div><label className={ui.label}>Relationship</label>
                      <select className={ui.select} disabled={dis} value={d.relationship ?? 'self'}
                        onChange={(e) => setDrivers((arr) => arr.map((x, j) => j === i ? { ...x, relationship: e.target.value } : x))}>
                        <option value="self">Self</option><option value="spouse">Spouse</option>
                        <option value="child">Child</option><option value="other">Other</option>
                      </select></div>
                    <div><label className={ui.label}>License number</label>
                      <input className={ui.input} disabled={dis} value={d.license_number ?? ''}
                        onChange={(e) => setDrivers((arr) => arr.map((x, j) => j === i ? { ...x, license_number: e.target.value || null } : x))} /></div>
                    <div><label className={ui.label}>License state * (submit requires one)</label>
                      <select className={ui.select} disabled={dis} value={d.license_state ?? ''}
                        onChange={(e) => setDrivers((arr) => arr.map((x, j) => j === i ? { ...x, license_state: e.target.value || null } : x))}>
                        <option value="">—</option>
                        {US_STATES.map((st) => <option key={st} value={st}>{st}</option>)}
                        <option value="FOREIGN">Foreign</option>
                      </select></div>
                    <div><label className={ui.label}>License status</label>
                      <select className={ui.select} disabled={dis} value={d.license_status ?? 'valid'}
                        onChange={(e) => setDrivers((arr) => arr.map((x, j) => j === i ? { ...x, license_status: e.target.value } : x))}>
                        <option value="valid">Valid</option><option value="permit">Permit</option>
                        <option value="foreign">Foreign</option><option value="suspended">Suspended</option>
                      </select></div>
                    <div><label className={ui.label}>Years licensed</label>
                      <input type="number" min={0} className={ui.input} disabled={dis} value={d.years_licensed ?? ''}
                        onChange={(e) => setDrivers((arr) => arr.map((x, j) => j === i ? { ...x, years_licensed: e.target.value === '' ? null : Number(e.target.value) } : x))} /></div>
                    <label className={`${ui.checkboxRow} mt-5`}>
                      <input type="checkbox" disabled={dis} checked={d.sr22_required}
                        onChange={(e) => setDrivers((arr) => arr.map((x, j) => j === i ? { ...x, sr22_required: e.target.checked } : x))} />
                      SR-22 required
                    </label>
                  </div>
                </div>
              ))}
            </div>
          </section>

          <section className={ui.card}>
            <div className={ui.cardHeader}>
              <h3 className={ui.sectionTitle}>Vehicles ({vehicles.length})</h3>
              {!readOnly && (
                <button type="button" className={ui.btnSecondary}
                  onClick={() => setVehicles((v) => [...v, { ...emptyVehicle(), position: v.length + 1 }])}>
                  Add vehicle
                </button>
              )}
            </div>
            <div className={`${ui.cardPad} space-y-4`}>
              {vehicles.map((v, i) => (
                <div key={i} className="rounded-md border border-slate-200 p-3">
                  <div className="mb-2 flex items-center justify-between">
                    <span className="text-xs font-semibold text-slate-500">Vehicle {i + 1}</span>
                    {!readOnly && vehicles.length > 1 && (
                      <button type="button" className={ui.btnGhost}
                        onClick={() => setVehicles((arr) => arr.filter((_, j) => j !== i))}>
                        Remove
                      </button>
                    )}
                  </div>
                  <div className={ui.fieldRow}>
                    <div><label className={ui.label}>Year</label>
                      <input type="number" className={ui.input} disabled={dis} value={v.year ?? ''}
                        onChange={(e) => setVehicles((arr) => arr.map((x, j) => j === i ? { ...x, year: e.target.value === '' ? null : Number(e.target.value) } : x))} /></div>
                    <div><label className={ui.label}>Make</label>
                      <input className={ui.input} disabled={dis} value={v.make ?? ''}
                        onChange={(e) => setVehicles((arr) => arr.map((x, j) => j === i ? { ...x, make: e.target.value || null } : x))} /></div>
                    <div><label className={ui.label}>Model</label>
                      <input className={ui.input} disabled={dis} value={v.model ?? ''}
                        onChange={(e) => setVehicles((arr) => arr.map((x, j) => j === i ? { ...x, model: e.target.value || null } : x))} /></div>
                    <div className="sm:col-span-2"><label className={ui.label}>VIN * (or mark VIN pending)</label>
                      <input className={ui.input} disabled={dis || v.vin_pending} value={v.vin ?? ''}
                        onChange={(e) => setVehicles((arr) => arr.map((x, j) => j === i ? { ...x, vin: e.target.value || null } : x))} /></div>
                    <label className={`${ui.checkboxRow} mt-5`}>
                      <input type="checkbox" disabled={dis} checked={v.vin_pending}
                        onChange={(e) => setVehicles((arr) => arr.map((x, j) => j === i ? { ...x, vin_pending: e.target.checked, vin: e.target.checked ? null : x.vin } : x))} />
                      VIN pending
                    </label>
                    <div><label className={ui.label}>Ownership</label>
                      <select className={ui.select} disabled={dis} value={v.ownership ?? 'owned'}
                        onChange={(e) => setVehicles((arr) => arr.map((x, j) => j === i ? { ...x, ownership: e.target.value } : x))}>
                        <option value="owned">Owned</option><option value="financed">Financed</option>
                        <option value="leased">Leased</option>
                      </select></div>
                    <div><label className={ui.label}>Lienholder</label>
                      <input className={ui.input} disabled={dis} value={v.lienholder ?? ''}
                        onChange={(e) => setVehicles((arr) => arr.map((x, j) => j === i ? { ...x, lienholder: e.target.value || null } : x))} /></div>
                    <div><label className={ui.label}>Usage</label>
                      <select className={ui.select} disabled={dis} value={v.usage ?? 'commute'}
                        onChange={(e) => setVehicles((arr) => arr.map((x, j) => j === i ? { ...x, usage: e.target.value } : x))}>
                        <option value="commute">Commute</option><option value="pleasure">Pleasure</option>
                        <option value="business">Business</option><option value="rideshare">Rideshare</option>
                      </select></div>
                    <div><label className={ui.label}>Annual mileage</label>
                      <input type="number" className={ui.input} disabled={dis} value={v.annual_mileage ?? ''}
                        onChange={(e) => setVehicles((arr) => arr.map((x, j) => j === i ? { ...x, annual_mileage: e.target.value === '' ? null : Number(e.target.value) } : x))} /></div>
                    <div><label className={ui.label}>Garaging ZIP</label>
                      <input className={ui.input} disabled={dis} value={v.garaging_zip ?? ''}
                        onChange={(e) => setVehicles((arr) => arr.map((x, j) => j === i ? { ...x, garaging_zip: e.target.value || null } : x))} /></div>
                  </div>
                </div>
              ))}
            </div>
          </section>
        </>
      )}

      {/* Current coverage + notes */}
      <section className={ui.card}>
        <div className={ui.cardHeader}><h3 className={ui.sectionTitle}>Current coverage &amp; notes</h3></div>
        <div className={`${ui.cardPad} ${ui.fieldRow}`}>
          <div><label className={ui.label}>Current carrier</label>
            <input className={ui.input} disabled={dis} value={s.current_carrier ?? ''}
              onChange={(e) => set({ current_carrier: e.target.value || null })} /></div>
          <div><label className={ui.label}>Current policy number</label>
            <input className={ui.input} disabled={dis} value={s.current_policy_number ?? ''}
              onChange={(e) => set({ current_policy_number: e.target.value || null })} /></div>
          <div><label className={ui.label}>Current premium ($)</label>
            <input type="number" step="0.01" className={ui.input} disabled={dis} value={s.current_premium ?? ''}
              onChange={(e) => set({ current_premium: e.target.value === '' ? null : Number(e.target.value) })} /></div>
          <div><label className={ui.label}>Policy expiration</label>
            <input type="date" className={ui.input} disabled={dis} value={s.current_expiration ?? ''}
              onChange={(e) => set({ current_expiration: e.target.value || null })} /></div>
          <div><label className={ui.label}>Months of continuous coverage</label>
            <input type="number" min={0} className={ui.input} disabled={dis}
              value={s.months_continuous_coverage ?? ''}
              onChange={(e) => set({ months_continuous_coverage: e.target.value === '' ? null : Number(e.target.value) })} /></div>
          <div className="flex flex-col justify-end gap-1 pb-0.5">
            <label className={ui.checkboxRow}>
              <input type="checkbox" disabled={dis} checked={s.prior_insurance ?? false}
                onChange={(e) => set({ prior_insurance: e.target.checked })} />
              Had prior insurance
            </label>
            <label className={ui.checkboxRow}>
              <input type="checkbox" disabled={dis} checked={s.prior_lapse ?? false}
                onChange={(e) => set({ prior_lapse: e.target.checked })} />
              Lapse in coverage
            </label>
          </div>
          <div className="sm:col-span-2 lg:col-span-3">
            <label className={ui.label}>Notes for the agent (optional — never a substitute for the fields above)</label>
            <textarea rows={3} className={ui.textarea} disabled={dis} value={s.csr_notes ?? ''}
              onChange={(e) => set({ csr_notes: e.target.value || null })} />
          </div>
        </div>
      </section>

      {!readOnly && (
        <div className="flex items-center justify-end gap-2">
          <button type="button" className={ui.btnSecondary} disabled={busy} onClick={onDone}>
            Close
          </button>
          <button type="button" className={ui.btnSecondary} disabled={busy}
            onClick={() => handleSave(false)}>
            Save draft
          </button>
          <button type="button" className={ui.btnPrimary} disabled={busy}
            onClick={() => handleSave(true)}>
            Submit to agents
          </button>
        </div>
      )}
    </div>
  );
}
