'use client';

import { Package, AlertTriangle, Info, Snowflake } from 'lucide-react';
import { useState } from 'react';
import { ui } from '../nhwd-shared/ui';

/* -------------------------------------------------------------------------- */
/*  Types                                                                     */
/* -------------------------------------------------------------------------- */

export interface CargoCommodity {
  category: string;
  frequency: 'mostly' | 'sometimes' | 'occasionally';
  is_primary: boolean;
  /** Share of hauling this commodity represents. Validated to total ≈100%. */
  percent_hauled?: number | null;
  average_value?: number | null;
  maximum_value?: number | null;
}

export interface CargoData {
  // Structured commodities
  commodities: CargoCommodity[];
  primary_commodity: string;
  cargo_description: string;

  // Cargo coverage desired (mandatory for trucking)
  cargo_coverage_desired: boolean | null;

  // Broker / load board
  broker_load_board: boolean | null;
  commodity_mix_known: boolean | null;

  // Cargo value
  typical_load_value: number | null;
  max_load_value: number | null;
  requested_cargo_limit: number | null;
  cargo_deductible: number | null;

  // Refrigerated
  refrigerated: boolean | null;
  temperature_controlled_equipment: boolean | null;
  reefer_breakdown_requested: string;

  // Hazmat
  hazmat: string;

  // High-value flag (computed)
  high_value_cargo_flag: boolean;

  // Auto hauling
  auto_hauling_vehicles_per_load: number | null;
  auto_hauling_max_value: number | null;

  // Machinery
  machinery_max_value: number | null;

  // Excluded cargo (yes/no/unsure map)
  excluded_cargo: Record<string, string>;
}

interface CargoSectionProps {
  data: CargoData;
  onChange: (patch: Partial<CargoData>) => void;
  /** Whether motor truck cargo coverage was requested (shows value fields) */
  cargoRequested?: boolean;
  disabled?: boolean;
}

/* -------------------------------------------------------------------------- */
/*  Constants                                                                  */
/* -------------------------------------------------------------------------- */

export const COMMODITY_CATEGORIES = [
  { key: 'general_consumer_goods', label: 'General Consumer Goods', examples: 'packaged household products, retail merchandise, clothing, paper products' },
  { key: 'furniture_household', label: 'Furniture / Household Goods', examples: 'furniture, mattresses, appliances, home furnishings, moving goods' },
  { key: 'appliances', label: 'Appliances', examples: 'washers, dryers, refrigerators, stoves, dishwashers, HVAC units' },
  { key: 'building_construction', label: 'Building / Construction Materials', examples: 'lumber, roofing, drywall, flooring, plumbing, construction supplies' },
  { key: 'machinery_equipment', label: 'Machinery / Equipment', examples: 'construction equipment, industrial machinery, generators, tools' },
  { key: 'automotive', label: 'Automotive', examples: 'auto parts, tires, engines, vehicle components' },
  { key: 'food_grocery', label: 'Food / Grocery', examples: 'packaged food, canned goods, beverages, produce, grocery products' },
  { key: 'refrigerated_frozen', label: 'Refrigerated / Frozen Goods', examples: 'frozen food, refrigerated food, meat, dairy, temperature-sensitive' },
  { key: 'electronics', label: 'Electronics', examples: 'TVs, computers, appliances, telecommunications equipment' },
  { key: 'high_value_merchandise', label: 'High-Value Merchandise', examples: 'electronics, luxury goods, high-value equipment, high-value retail' },
  { key: 'metals', label: 'Metals', examples: 'steel, aluminum, coils, fabricated metal, scrap metal' },
  { key: 'agricultural', label: 'Agricultural Products', examples: 'produce, grain, feed, farm products, livestock-related' },
  { key: 'vehicles_auto_hauling', label: 'Vehicles / Auto Hauling', examples: 'personal automobiles, dealer vehicles, auction vehicles, salvage' },
  { key: 'boats_recreational', label: 'Boats / Recreational Vehicles', examples: 'boats, RVs, recreational vehicles' },
  { key: 'mobile_homes_oversized', label: 'Mobile Homes / Oversized Loads', examples: 'mobile homes, wide loads, oversized cargo' },
  { key: 'waste_debris', label: 'Waste / Debris / Junk', examples: 'construction debris, scrap, junk removal' },
  { key: 'landscaping', label: 'Landscaping Materials', examples: 'mulch, stone, soil, plants, landscaping supplies' },
  { key: 'bulk_materials', label: 'Bulk Materials', examples: 'sand, gravel, aggregate' },
  { key: 'liquids', label: 'Liquids', examples: 'fuel, water, liquid chemicals, liquid food products' },
  { key: 'chemicals', label: 'Chemicals', examples: 'industrial chemicals, cleaning products, solvents' },
  { key: 'hazardous_materials', label: 'Hazardous Materials', examples: 'flammable, corrosive, radioactive, toxic materials' },
  { key: 'alcohol', label: 'Alcohol', examples: 'beer, wine, spirits' },
  { key: 'tobacco', label: 'Tobacco', examples: 'cigarettes, cigars, tobacco products' },
  { key: 'pharmaceuticals', label: 'Pharmaceuticals / Medical Supplies', examples: 'medications, medical devices, hospital supplies' },
  { key: 'livestock', label: 'Livestock', examples: 'cattle, horses, poultry, live animals' },
  { key: 'other', label: 'Other', examples: '' },
] as const;

/**
 * The prohibited-cargo questions, asked by label.
 *
 * Exported because the Specialty Quote workspace reads and corrects the same
 * `excluded_cargo` map: its keys are these strings, so a second list would produce
 * answers this form could not display back.
 */
export const EXCLUDED_CARGO_ITEMS = [
  'Hazardous Materials',
  'Refrigerated/Frozen Goods',
  'Alcohol',
  'Tobacco',
  'Pharmaceuticals',
  'Electronics / High-Value Goods',
  'Automobiles',
  'Livestock',
  'Oversized Loads',
  'Scrap / Waste',
  'Chemicals',
] as const;

// Cargo limit choices now live in RequestedCoveragesSection (CARGO_LIMIT_CHOICES),
// so the limit is asked exactly once.

const LOAD_VALUE_RANGES = [
  { value: 'under_25000', label: 'Under $25,000' },
  { value: '25000_50000', label: '$25,000 - $50,000' },
  { value: '50001_100000', label: '$50,001 - $100,000' },
  { value: 'over_100000', label: 'Over $100,000' },
  { value: 'unknown', label: 'Unknown' },
] as const;

/** Categories that trigger the high-value cargo flag */
const HIGH_VALUE_CATEGORIES = new Set([
  'electronics',
  'high_value_merchandise',
  'pharmaceuticals',
]);

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Derives the aggregate load values from the per-commodity detail.
 *
 * `max_load_value` is the largest single-load maximum across all commodities.
 * `typical_load_value` is the percent-weighted average where percentages are
 * known, and a plain average otherwise. Returns nulls when nothing is entered,
 * so a partially filled form does not invent figures.
 */
function rollupCargoValues(rows: CargoCommodity[]): {
  typical_load_value: number | null;
  max_load_value: number | null;
} {
  const maximums = rows
    .map((row) => row.maximum_value)
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  const maxLoad = maximums.length > 0 ? Math.max(...maximums) : null;

  const withAverage = rows.filter(
    (row) => typeof row.average_value === 'number' && Number.isFinite(row.average_value),
  );
  let typicalLoad: number | null = null;
  if (withAverage.length > 0) {
    const weightTotal = withAverage.reduce((sum, row) => sum + (row.percent_hauled ?? 0), 0);
    if (weightTotal > 0) {
      const weighted = withAverage.reduce(
        (sum, row) => sum + (row.average_value as number) * (row.percent_hauled ?? 0),
        0,
      );
      typicalLoad = Math.round(weighted / weightTotal);
    } else {
      const plain = withAverage.reduce((sum, row) => sum + (row.average_value as number), 0);
      typicalLoad = Math.round(plain / withAverage.length);
    }
  }

  return { typical_load_value: typicalLoad, max_load_value: maxLoad };
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

function AgentGuidance({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2.5 rounded-2xl border border-blue-100 bg-blue-50/60 px-4 py-3">
      <Info className="mt-0.5 h-4 w-4 shrink-0 text-blue-500" />
      <div className="text-xs font-semibold leading-5 text-blue-800">
        {children}
      </div>
    </div>
  );
}

function WarningBanner({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2.5 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
      <div className="text-sm font-bold text-amber-800">
        {children}
      </div>
    </div>
  );
}

function DangerBanner({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2.5 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-rose-600" />
      <div className="text-sm font-bold text-rose-800">
        {children}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Component                                                                  */
/* -------------------------------------------------------------------------- */

export default function CargoSection({ data, onChange, cargoRequested = false, disabled }: CargoSectionProps) {
  const [showFollowUp, setShowFollowUp] = useState(false);

  // Derived state
  const selectedCategories = new Set(data.commodities.map((c) => c.category));
  const hasHazmat = data.hazmat === 'yes' || data.hazmat === 'unsure';
  const hasRefrigerated = selectedCategories.has('refrigerated_frozen') || data.refrigerated === true;
  const hasAutoHauling = selectedCategories.has('vehicles_auto_hauling');
  const hasMachinery = selectedCategories.has('machinery_equipment');
  const hasChemicals = selectedCategories.has('chemicals');
  const hasHighValue = [...selectedCategories].some((cat) => HIGH_VALUE_CATEGORIES.has(cat));
  const highValueFlag = hasHighValue || (data.max_load_value != null && data.max_load_value > 100000);
  const cargoValueExceedsLimit = data.max_load_value != null
    && data.requested_cargo_limit != null
    && data.max_load_value > data.requested_cargo_limit;

  // Commodity percentages should describe the whole operation, so they are
  // totalled and checked against ~100%. Only surfaced once at least one is
  // entered, so a fresh form does not nag.
  const percentTotal = data.commodities.reduce((sum, row) => sum + (row.percent_hauled ?? 0), 0);
  const anyPercentEntered = data.commodities.some(
    (row) => typeof row.percent_hauled === 'number' && row.percent_hauled > 0,
  );
  const percentTotalOk = percentTotal >= 98 && percentTotal <= 102;
  /** True once any per-commodity load value exists, so the aggregate is derived. */
  const hasPerCommodityValues = data.commodities.some(
    (row) => row.average_value != null || row.maximum_value != null,
  );

  // Update high-value flag when computed value changes
  if (highValueFlag !== data.high_value_cargo_flag) {
    onChange({ high_value_cargo_flag: highValueFlag });
  }

  /* ──── Category toggle ──────────────────────────────────────────────────── */
  function toggleCategory(key: string) {
    if (disabled) return;
    const existing = data.commodities.find((c) => c.category === key);
    let updated: CargoCommodity[];
    let nextPrimary = data.primary_commodity;

    if (existing) {
      updated = data.commodities.filter((c) => c.category !== key);
      // If the removed one was primary, the selection no longer has a primary.
      if (existing.is_primary) nextPrimary = '';
    } else {
      const newCommodity: CargoCommodity = {
        category: key,
        frequency: 'mostly',
        is_primary: data.commodities.length === 0,
        percent_hauled: null,
        average_value: null,
        maximum_value: null,
      };
      updated = [...data.commodities, newCommodity];
      // First selection becomes primary.
      if (data.commodities.length === 0) nextPrimary = key;
    }

    // One change, so the rows, the primary and the derived load values can
    // never disagree.
    onChange({
      commodities: updated,
      primary_commodity: nextPrimary,
      ...rollupCargoValues(updated),
    });
  }

  function setFrequency(key: string, freq: 'mostly' | 'sometimes' | 'occasionally') {
    if (disabled) return;
    const updated = data.commodities.map((c) =>
      c.category === key ? { ...c, frequency: freq } : c
    );
    onChange({ commodities: updated });
  }

  function setPrimary(key: string) {
    if (disabled) return;
    const updated = data.commodities.map((c) => ({
      ...c,
      is_primary: c.category === key,
    }));
    onChange({ commodities: updated, primary_commodity: key });
  }

  /**
   * Updates one commodity's percent / average / maximum and re-derives the
   * aggregate load values in the same change.
   *
   * Deriving them means Customer Service never types the overall figures twice,
   * and the cargo-limit warning keeps working off real numbers.
   */
  function setCommodityDetail(key: string, detail: Partial<CargoCommodity>) {
    if (disabled) return;
    const updated = data.commodities.map((c) =>
      c.category === key ? { ...c, ...detail } : c,
    );
    onChange({ commodities: updated, ...rollupCargoValues(updated) });
  }

  function setExcluded(item: string, value: string) {
    if (disabled) return;
    const updated = { ...data.excluded_cargo, [item]: value };
    onChange({ excluded_cargo: updated });
  }

  /* ──── "Dry Freight" / "General Freight" detection ──────────────────────── */
  // This is handled by showing a follow-up prompt in the description field
  function handleDescriptionChange(value: string) {
    onChange({ cargo_description: value });
    const lower = value.toLowerCase().trim();
    const vague = ['dry freight', 'general freight', 'general cargo', 'everything', 'whatever'];
    setShowFollowUp(vague.some((v) => lower.includes(v)) && data.commodities.length === 0);
  }

  return (
    <section className={ui.card}>
      <div className={ui.cardHeader}>
        <div className="flex items-start gap-3">
          <div className="grid h-10 w-10 shrink-0 place-items-center rounded-2xl bg-[#eef3fb] text-[#223f7a]">
            <Package className="h-5 w-5" />
          </div>
          <div>
            <h3 className="text-lg font-black text-slate-950">Cargo / Commodities</h3>
            <p className="mt-1 text-sm font-semibold text-slate-500">
              What does the company actually transport? Select all that apply.
            </p>
          </div>
        </div>
      </div>

      <div className={ui.cardPad}>
        <div className="space-y-6">

          {/* ─── Agent Guidance ─────────────────────────────────────────────── */}
          <AgentGuidance>
            <strong>Be specific.</strong> &quot;Dry Freight&quot; or &quot;General Freight&quot; is not enough by itself.
            Ask the customer what is normally inside the truck.
            <br />
            <span className="mt-1 block italic">
              &quot;What do you normally haul? If you say dry freight or general freight, can you give me
              two or three examples of what is normally inside the truck?&quot;
            </span>
          </AgentGuidance>

          {/* ─── Commodity Category Multi-Select ───────────────────────────── */}
          <div>
            <span className={ui.label}>Commodity Categories *</span>
            <p className="mt-1 mb-3 text-xs font-semibold text-slate-400">
              Select all commodities the customer transports. Click again to remove.
            </p>
            <div className="flex flex-wrap gap-2">
              {COMMODITY_CATEGORIES.map((cat) => {
                const isSelected = selectedCategories.has(cat.key);
                return (
                  <button
                    key={cat.key}
                    type="button"
                    onClick={() => toggleCategory(cat.key)}
                    disabled={disabled}
                    className={`rounded-xl border px-3 py-2 text-xs font-bold transition ${
                      isSelected
                        ? 'border-[#223f7a] bg-[#eef3fb] text-[#223f7a]'
                        : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300 hover:bg-slate-50'
                    } disabled:cursor-not-allowed disabled:opacity-40`}
                    title={cat.examples || undefined}
                  >
                    {cat.label}
                  </button>
                );
              })}
            </div>
          </div>

          {/* ─── Selected Commodities: Frequency & Primary ─────────────────── */}
          {data.commodities.length > 0 && (
            <div>
              <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
                <div>
                  <span className={ui.label}>Commodity Mix</span>
                  <p className="mt-1 text-xs font-semibold text-slate-400">
                    Set how often each is hauled, what a load is worth, and which is primary.
                  </p>
                </div>
                {anyPercentEntered && (
                  <span
                    className={`${ui.badge} ${
                      percentTotalOk ? ui.badgeTone.success : ui.badgeTone.progress
                    }`}
                  >
                    Total {percentTotal}%
                  </span>
                )}
              </div>
              <div className="space-y-2">
                {data.commodities.map((comm) => {
                  const catDef = COMMODITY_CATEGORIES.find((c) => c.key === comm.category);
                  return (
                    <div
                      key={comm.category}
                      className={`rounded-xl border px-4 py-3 ${
                        comm.is_primary ? 'border-[#223f7a] bg-[#f8faff]' : 'border-slate-200 bg-white'
                      }`}
                    >
                      <div className="flex flex-wrap items-center gap-3">
                        <span className="min-w-[160px] text-sm font-bold text-slate-800">
                          {catDef?.label || comm.category}
                        </span>

                        {/* Frequency selector */}
                        <div className="flex gap-1">
                          {(['mostly', 'sometimes', 'occasionally'] as const).map((freq) => (
                            <button
                              key={freq}
                              type="button"
                              onClick={() => setFrequency(comm.category, freq)}
                              disabled={disabled}
                              className={`rounded-lg px-2.5 py-1 text-[11px] font-bold capitalize transition ${
                                comm.frequency === freq
                                  ? 'bg-[#223f7a] text-white'
                                  : 'bg-slate-100 text-slate-500 hover:bg-slate-200'
                              } disabled:cursor-not-allowed disabled:opacity-40`}
                            >
                              {freq}
                            </button>
                          ))}
                        </div>

                        {/* Primary button */}
                        <button
                          type="button"
                          onClick={() => setPrimary(comm.category)}
                          disabled={disabled}
                          className={`ml-auto rounded-lg px-2.5 py-1 text-[11px] font-bold transition ${
                            comm.is_primary
                              ? 'bg-emerald-100 text-emerald-700'
                              : 'bg-slate-50 text-slate-400 hover:bg-slate-100 hover:text-slate-600'
                          } disabled:cursor-not-allowed disabled:opacity-40`}
                        >
                          {comm.is_primary ? 'Primary' : 'Set Primary'}
                        </button>
                      </div>

                      {/* Per-commodity detail: what share, and what a load is worth. */}
                      <div className="mt-3 grid grid-cols-1 gap-3 border-t border-slate-100 pt-3 sm:grid-cols-3">
                        <label className="block">
                          <span className="text-[11px] font-black uppercase tracking-wider text-slate-400">
                            Percent Hauled
                          </span>
                          <div className="relative mt-1">
                            <input
                              type="number"
                              min={0}
                              max={100}
                              className={`${ui.input} mt-0 pr-8`}
                              value={comm.percent_hauled ?? ''}
                              onChange={(e) =>
                                setCommodityDetail(comm.category, {
                                  percent_hauled: e.target.value === '' ? null : Number(e.target.value),
                                })
                              }
                              placeholder="e.g. 60"
                              disabled={disabled}
                            />
                            <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-sm font-bold text-slate-400">
                              %
                            </span>
                          </div>
                        </label>

                        <label className="block">
                          <span className="text-[11px] font-black uppercase tracking-wider text-slate-400">
                            Average Load Value
                          </span>
                          <input
                            type="number"
                            min={0}
                            className={`${ui.input} mt-1`}
                            value={comm.average_value ?? ''}
                            onChange={(e) =>
                              setCommodityDetail(comm.category, {
                                average_value: e.target.value === '' ? null : Number(e.target.value),
                              })
                            }
                            placeholder="e.g. 40000"
                            disabled={disabled}
                          />
                        </label>

                        <label className="block">
                          <span className="text-[11px] font-black uppercase tracking-wider text-slate-400">
                            Maximum Load Value
                          </span>
                          <input
                            type="number"
                            min={0}
                            className={`${ui.input} mt-1`}
                            value={comm.maximum_value ?? ''}
                            onChange={(e) =>
                              setCommodityDetail(comm.category, {
                                maximum_value: e.target.value === '' ? null : Number(e.target.value),
                              })
                            }
                            placeholder="e.g. 75000"
                            disabled={disabled}
                          />
                        </label>
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Percentages should describe the whole operation. */}
              {anyPercentEntered && !percentTotalOk && (
                <div className="mt-3">
                  <WarningBanner>
                    Commodity percentages total {percentTotal}%. They should add up to about 100% so
                    underwriting can see the whole operation.
                  </WarningBanner>
                </div>
              )}
            </div>
          )}

          {/* ─── Dry Freight / General Freight Follow-Up ───────────────────── */}
          {showFollowUp && (
            <WarningBanner>
              <strong>What kind of dry freight do you normally haul?</strong>
              <br />
              Examples: Furniture, retail merchandise, building materials, packaged food,
              auto parts, electronics, machinery, clothing, household goods.
              <br />
              <span className="mt-1 block font-semibold">
                Please select the 2-3 most common commodities from the categories above.
              </span>
            </WarningBanner>
          )}

          {/* ─── Broker / Load Board ───────────────────────────────────────── */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Loads from Broker / Load Board?">
              <select
                className={ui.select}
                value={data.broker_load_board === null ? '' : data.broker_load_board ? 'yes' : 'no'}
                onChange={(e) => {
                  const val = e.target.value;
                  onChange({ broker_load_board: val === '' ? null : val === 'yes' });
                }}
                disabled={disabled}
              >
                <option value="">-- Select --</option>
                <option value="yes">Yes</option>
                <option value="no">No</option>
              </select>
            </Field>

            {data.broker_load_board === true && (
              <Field label="Commodity Mix Fully Known?">
                <select
                  className={ui.select}
                  value={data.commodity_mix_known === null ? '' : data.commodity_mix_known ? 'yes' : 'no'}
                  onChange={(e) => {
                    const val = e.target.value;
                    onChange({ commodity_mix_known: val === '' ? null : val === 'yes' });
                  }}
                  disabled={disabled}
                >
                  <option value="">-- Select --</option>
                  <option value="yes">Yes</option>
                  <option value="no">No — mix varies by load board availability</option>
                </select>
              </Field>
            )}
          </div>

          {data.broker_load_board === true && (
            <AgentGuidance>
              &quot;What kinds of loads do you usually accept or expect to accept from the load board?&quot;
            </AgentGuidance>
          )}

          {/* ─── Operations / Cargo Description ────────────────────────────── */}
          <Field label="Operations / Cargo Description" hint="Complements the category selections above. Describe the typical operation.">
            <textarea
              className={ui.textarea}
              rows={3}
              value={data.cargo_description}
              onChange={(e) => handleDescriptionChange(e.target.value)}
              placeholder="e.g. Mostly furniture and packaged household products from distribution centers. Occasionally building materials. No refrigerated or hazardous cargo."
              disabled={disabled}
            />
          </Field>

          {/* ─── Refrigerated Follow-Up ────────────────────────────────────── */}
          {(hasRefrigerated || selectedCategories.has('food_grocery')) && (
            <div className="rounded-2xl border border-cyan-100 bg-cyan-50/40 p-4">
              <div className="mb-3 flex items-center gap-2">
                <Snowflake className="h-4 w-4 text-cyan-600" />
                <span className="text-sm font-black text-cyan-800">Refrigerated Cargo</span>
              </div>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                <Field label="Refrigerated / Temperature Controlled?">
                  <select
                    className={ui.select}
                    value={data.refrigerated === null ? '' : data.refrigerated ? 'yes' : 'no'}
                    onChange={(e) => {
                      const val = e.target.value;
                      onChange({ refrigerated: val === '' ? null : val === 'yes' });
                    }}
                    disabled={disabled}
                  >
                    <option value="">-- Select --</option>
                    <option value="yes">Yes</option>
                    <option value="no">No</option>
                  </select>
                </Field>

                {data.refrigerated === true && (
                  <>
                    <Field label="Temperature-Controlled Equipment?">
                      <select
                        className={ui.select}
                        value={data.temperature_controlled_equipment === null ? '' : data.temperature_controlled_equipment ? 'yes' : 'no'}
                        onChange={(e) => {
                          const val = e.target.value;
                          onChange({ temperature_controlled_equipment: val === '' ? null : val === 'yes' });
                        }}
                        disabled={disabled}
                      >
                        <option value="">-- Select --</option>
                        <option value="yes">Yes</option>
                        <option value="no">No</option>
                      </select>
                    </Field>

                    <Field label="Reefer Breakdown Coverage?">
                      <select
                        className={ui.select}
                        value={data.reefer_breakdown_requested}
                        onChange={(e) => onChange({ reefer_breakdown_requested: e.target.value })}
                        disabled={disabled}
                      >
                        <option value="">-- Select --</option>
                        <option value="yes">Yes</option>
                        <option value="no">No</option>
                        <option value="unsure">Unsure</option>
                      </select>
                    </Field>
                  </>
                )}
              </div>
            </div>
          )}

          {/* ─── Auto Hauling Follow-Up ────────────────────────────────────── */}
          {hasAutoHauling && (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label="Typical Vehicles Per Load">
                <input
                  type="number"
                  className={ui.input}
                  value={data.auto_hauling_vehicles_per_load ?? ''}
                  onChange={(e) => onChange({ auto_hauling_vehicles_per_load: e.target.value ? Number(e.target.value) : null })}
                  placeholder="e.g. 6"
                  min={1}
                  disabled={disabled}
                />
              </Field>
              <Field label="Maximum Total Value of Vehicles Per Load">
                <input
                  type="number"
                  className={ui.input}
                  value={data.auto_hauling_max_value ?? ''}
                  onChange={(e) => onChange({ auto_hauling_max_value: e.target.value ? Number(e.target.value) : null })}
                  placeholder="e.g. 350000"
                  min={0}
                  disabled={disabled}
                />
              </Field>
            </div>
          )}

          {/* ─── Machinery Follow-Up ───────────────────────────────────────── */}
          {hasMachinery && (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label="Typical Maximum Value of One Piece/Load" hint="For Machinery / Equipment loads">
                <input
                  type="number"
                  className={ui.input}
                  value={data.machinery_max_value ?? ''}
                  onChange={(e) => onChange({ machinery_max_value: e.target.value ? Number(e.target.value) : null })}
                  placeholder="e.g. 200000"
                  min={0}
                  disabled={disabled}
                />
              </Field>
            </div>
          )}

          {/* ─── Chemicals selected, but hazmat not yet answered ─────────────
              The hazmat question itself lives in the Underwriting / Eligibility
              section so it is always asked, not only when a chemical commodity
              happens to be selected. This just points there. */}
          {(hasChemicals || selectedCategories.has('hazardous_materials')) && !data.hazmat && (
            <WarningBanner>
              A hazmat-adjacent commodity is selected. Answer <strong>Hauls hazardous
              materials?</strong> in the Underwriting / Eligibility section below.
            </WarningBanner>
          )}

          {/* ─── Hazmat Flag ───────────────────────────────────────────────── */}
          {hasHazmat && (
            <DangerBanner>
              Hazmat — Specialty Review Required
            </DangerBanner>
          )}

          {/* ─── High-Value Cargo Flag ─────────────────────────────────────── */}
          {highValueFlag && (
            <WarningBanner>
              High-Value Cargo — Specialty Review
            </WarningBanner>
          )}

          {/* ─── Excluded / Prohibited Cargo ───────────────────────────────── */}
          <div>
            <span className={ui.label}>Excluded / Prohibited Cargo</span>
            <p className="mt-1 mb-3 text-xs font-semibold text-slate-400">
              Does the company ever haul any of the following?
            </p>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {EXCLUDED_CARGO_ITEMS.map((item) => (
                <div key={item} className="flex items-center gap-2 rounded-xl border border-slate-100 px-3 py-2">
                  <span className="flex-1 text-xs font-bold text-slate-700">{item}</span>
                  <select
                    className="rounded-lg border border-slate-200 bg-white px-2 py-1 text-[11px] font-bold text-slate-600 outline-none focus:border-[#7890bc]"
                    value={data.excluded_cargo[item] || ''}
                    onChange={(e) => setExcluded(item, e.target.value)}
                    disabled={disabled}
                  >
                    <option value="">—</option>
                    <option value="yes">Yes</option>
                    <option value="no">No</option>
                    <option value="unsure">Unsure</option>
                  </select>
                </div>
              ))}
            </div>
          </div>

          {/* ─── Cargo Value ─────────────────────────────────────────────────
              Desired Cargo Limit, Cargo Deductible and Refrigeration Breakdown
              are asked once, in the Requested Coverages card. This block only
              records what a load is actually worth. */}
          {cargoRequested && (
            <div className="rounded-2xl border border-slate-200 bg-slate-50/50 p-4">
              <span className={`${ui.label} mb-3 block`}>Cargo Values</span>

              <AgentGuidance>
                &quot;About how much is a normal load worth, and what would be the most expensive load you might carry?&quot;
              </AgentGuidance>

              {hasPerCommodityValues ? (
                /* Derived from the per-commodity values above, so the overall
                   figures are never entered twice. */
                <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <div className="rounded-xl border border-slate-200 bg-white px-4 py-3">
                    <p className="text-[11px] font-black uppercase tracking-wider text-slate-400">
                      Typical Value of One Load
                    </p>
                    <p className="mt-1 text-lg font-black text-slate-900">
                      {data.typical_load_value != null
                        ? `$${data.typical_load_value.toLocaleString()}`
                        : '—'}
                    </p>
                    <p className="mt-1 text-xs font-semibold text-slate-400">
                      Weighted by percent hauled
                    </p>
                  </div>
                  <div className="rounded-xl border border-slate-200 bg-white px-4 py-3">
                    <p className="text-[11px] font-black uppercase tracking-wider text-slate-400">
                      Maximum Value of Any One Load
                    </p>
                    <p className="mt-1 text-lg font-black text-slate-900">
                      {data.max_load_value != null
                        ? `$${data.max_load_value.toLocaleString()}`
                        : '—'}
                    </p>
                    <p className="mt-1 text-xs font-semibold text-slate-400">
                      Highest commodity maximum
                    </p>
                  </div>
                </div>
              ) : (
                /* No per-commodity values yet, so the overall figures can still
                   be captured directly. Keeps older intakes editable. */
                <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <Field label="Typical Value of One Load">
                    <input
                      type="number"
                      className={ui.input}
                      value={data.typical_load_value ?? ''}
                      onChange={(e) => onChange({ typical_load_value: e.target.value ? Number(e.target.value) : null })}
                      placeholder="e.g. 45000"
                      min={0}
                      disabled={disabled}
                    />
                  </Field>

                  <Field label="Maximum Value of Any One Load">
                    <input
                      type="number"
                      className={ui.input}
                      value={data.max_load_value ?? ''}
                      onChange={(e) => onChange({ max_load_value: e.target.value ? Number(e.target.value) : null })}
                      placeholder="e.g. 85000"
                      min={0}
                      disabled={disabled}
                    />
                  </Field>
                </div>
              )}

              {/* Cargo value warning */}
              {cargoValueExceedsLimit && (
                <div className="mt-4">
                  <WarningBanner>
                    Maximum reported load value exceeds the requested Cargo limit. Review coverage before quoting.
                  </WarningBanner>
                </div>
              )}
            </div>
          )}

          {/* ─── Agent Call Script (tooltip) ───────────────────────────────── */}
          <details className="rounded-2xl border border-slate-100 bg-slate-50/40">
            <summary className="cursor-pointer px-4 py-3 text-xs font-black uppercase tracking-wider text-slate-400">
              Agent Call Script
            </summary>
            <div className="space-y-2 px-4 pb-4 text-xs font-semibold leading-5 text-slate-600">
              <p>&quot;What do you normally haul? If you say dry freight or general freight, can you give me two or three examples of what is normally inside the truck?&quot;</p>
              <p>If the customer uses a load board: &quot;What kinds of loads do you usually accept or expect to accept?&quot;</p>
              <p>For value: &quot;About how much is a normal load worth, and what would be the most expensive load you might carry?&quot;</p>
            </div>
          </details>

        </div>
      </div>
    </section>
  );
}
