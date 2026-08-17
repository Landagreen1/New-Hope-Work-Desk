'use client';

/**
 * One address entry control, used everywhere an address has to be a real place
 * rather than typed text.
 *
 * This replaces the single-purpose AddressAutocomplete, which only handled the
 * customer street line and returned loose components for the caller to scatter
 * across its own inputs. That design is why the Renters rental-property address
 * ended up as four unrestricted text boxes: there was nothing reusable to reach
 * for. This component owns the whole address — street, unit, city, state, ZIP,
 * place ID, formatted line, and the verification flag — so the second address was
 * a matter of rendering it twice.
 *
 * Verification rules live in ./verified-address so they can be tested without a
 * browser or an API key.
 */

import { CheckCircle2, MapPin, TriangleAlert } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { ui } from './ui';
import {
  applyManualEdit,
  applyPlaceSelection,
  isAddressComplete,
  type PlaceSelection,
  type VerifiedAddressField as AddressField,
  type VerifiedAddressValue,
} from './verified-address';

/**
 * Google Maps browser key.
 *
 * Read from the environment so it can be rotated and referrer-restricted without
 * a code change. The literal fallback is the key this project has been shipping
 * inline since the intake form was written; it is kept only so that address
 * verification does not silently stop working in an environment where the
 * variable has not been set yet. Set NEXT_PUBLIC_GOOGLE_MAPS_API_KEY and the
 * fallback is never reached.
 */
const API_KEY =
  process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY ?? 'AIzaSyC4u00lSMI5AEXrDRlo_HrO8x7la5LiHeY';

let loadPromise: Promise<void> | null = null;

function ensureGoogleMaps(): Promise<void> {
  if (typeof window === 'undefined') return Promise.reject(new Error('No window'));
  if (window.google?.maps?.places) return Promise.resolve();
  if (loadPromise) return loadPromise;

  loadPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = `https://maps.googleapis.com/maps/api/js?key=${API_KEY}&libraries=places&loading=async`;
    script.async = true;
    script.defer = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('Google Maps failed to load'));
    document.head.appendChild(script);
  });
  return loadPromise;
}

interface Suggestion {
  placeId: string;
  text: string;
}

export interface VerifiedAddressFieldProps {
  value: VerifiedAddressValue;
  onChange: (next: VerifiedAddressValue) => void;
  disabled?: boolean;
  /** Shown above the street input. */
  streetLabel?: string;
  /** Marks street/city/state/ZIP as required in the labels. */
  required?: boolean;
  /**
   * When true, an incomplete or unverified address is called out in place.
   * Set this where submission actually depends on verification.
   */
  requireVerification?: boolean;
  /** Rendered under the group, e.g. to explain what the address is for. */
  hint?: string;
  /** Replaces the street input with read-only text, for derived addresses. */
  readOnlySummary?: boolean;
}

function Labelled({
  label,
  required,
  children,
}: {
  label: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className={ui.label}>
        {label}
        {required ? ' *' : ''}
      </span>
      {children}
    </label>
  );
}

export default function VerifiedAddressField({
  value,
  onChange,
  disabled,
  streetLabel = 'Street address',
  required,
  requireVerification,
  hint,
  readOnlySummary,
}: VerifiedAddressFieldProps) {
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [showDropdown, setShowDropdown] = useState(false);
  const [ready, setReady] = useState(false);
  const [lookupFailed, setLookupFailed] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sessionTokenRef = useRef<google.maps.places.AutocompleteSessionToken | null>(null);

  useEffect(() => {
    ensureGoogleMaps()
      .then(() => setReady(true))
      .catch(() => setLookupFailed(true));
  }, []);

  useEffect(() => {
    function handleClick(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setShowDropdown(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  useEffect(
    () => () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    },
    [],
  );

  const getSessionToken = useCallback(() => {
    if (!sessionTokenRef.current) {
      sessionTokenRef.current = new google.maps.places.AutocompleteSessionToken();
    }
    return sessionTokenRef.current;
  }, []);

  const fetchSuggestions = useCallback(
    async (input: string) => {
      if (!ready || input.trim().length < 3) {
        setSuggestions([]);
        return;
      }

      const request = {
        input,
        sessionToken: getSessionToken(),
        includedRegionCodes: ['us'],
      };

      // Street-level types first. Falling back to the unrestricted request
      // matters for rural and newly built addresses, which Google often only
      // returns as a geocode.
      for (const attempt of [
        { ...request, includedPrimaryTypes: ['street_address', 'subpremise', 'premise'] },
        request,
      ]) {
        try {
          const { suggestions: results } =
            await google.maps.places.AutocompleteSuggestion.fetchAutocompleteSuggestions(attempt);
          const mapped = (results ?? [])
            .filter((result) => result.placePrediction)
            .map((result) => ({
              placeId: result.placePrediction!.placeId,
              text: result.placePrediction!.text.text,
            }));
          if (mapped.length) {
            setSuggestions(mapped);
            setShowDropdown(true);
            return;
          }
        } catch {
          // Try the broader request, then give up quietly.
        }
      }
      setSuggestions([]);
    },
    [getSessionToken, ready],
  );

  function handleStreetInput(next: string) {
    // Every keystroke on the street line drops the verification. Re-selecting
    // from the dropdown is what restores it.
    onChange(applyManualEdit(value, 'street', next));
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => void fetchSuggestions(next), 300);
  }

  function handlePartInput(field: AddressField, next: string) {
    onChange(applyManualEdit(value, field, next));
  }

  async function handleSelect(suggestion: Suggestion) {
    setShowDropdown(false);
    setSuggestions([]);

    try {
      const place = new google.maps.places.Place({ id: suggestion.placeId });
      await place.fetchFields({ fields: ['addressComponents', 'formattedAddress'] });

      if (!place.addressComponents) return;

      let streetNumber = '';
      let route = '';
      let unit: string | null = null;
      let city = '';
      let state = '';
      let zip = '';

      for (const component of place.addressComponents) {
        const types = component.types;
        if (types.includes('street_number')) streetNumber = component.longText || '';
        else if (types.includes('route')) route = component.longText || '';
        else if (types.includes('subpremise')) unit = component.longText || null;
        else if (types.includes('locality') || types.includes('sublocality_level_1')) {
          city = component.longText || '';
        } else if (types.includes('administrative_area_level_1')) state = component.shortText || '';
        else if (types.includes('postal_code')) zip = component.longText || '';
      }

      const street =
        streetNumber && route ? `${streetNumber} ${route}` : route || streetNumber;

      const selection: PlaceSelection = {
        street,
        unit,
        city,
        state,
        zip,
        placeId: suggestion.placeId,
        formatted: place.formattedAddress ?? suggestion.text,
      };

      sessionTokenRef.current = null;
      onChange(applyPlaceSelection(value, selection));
    } catch {
      // A failed details lookup must not leave a half-filled address looking
      // verified, so only the visible text is updated.
      onChange(
        applyManualEdit(value, 'street', suggestion.text.split(',')[0] || suggestion.text),
      );
    }
  }

  const complete = isAddressComplete(value);
  const showUnverifiedWarning =
    requireVerification === true && !disabled && complete && !value.verified;
  const showIncompleteHint =
    requireVerification === true && !disabled && !complete && value.street.trim() !== '';

  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        <div className="lg:col-span-2">
          <div ref={containerRef} className="relative">
            <Labelled label={streetLabel} required={required}>
              {readOnlySummary ? (
                <p className="mt-2 rounded-xl border border-slate-200 bg-slate-50 px-3.5 py-2.5 text-sm font-semibold text-slate-600">
                  {value.street || 'Not provided'}
                </p>
              ) : (
                <input
                  className={ui.input}
                  disabled={disabled}
                  value={value.street}
                  onChange={(event) => handleStreetInput(event.target.value)}
                  onFocus={() => {
                    if (suggestions.length) setShowDropdown(true);
                  }}
                  placeholder="Start typing an address…"
                  autoComplete="off"
                  aria-describedby={value.verified ? 'address-verified' : undefined}
                />
              )}
            </Labelled>
            {showDropdown && suggestions.length > 0 ? (
              <ul className="absolute left-0 right-0 top-full z-50 mt-1 max-h-60 overflow-auto rounded-xl border border-slate-200 bg-white py-1 shadow-lg">
                {suggestions.map((suggestion) => (
                  <li key={suggestion.placeId}>
                    <button
                      type="button"
                      className="block w-full cursor-pointer px-4 py-2.5 text-left text-sm font-semibold text-slate-700 hover:bg-[#eef3fb] hover:text-[#223f7a]"
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => void handleSelect(suggestion)}
                    >
                      {suggestion.text}
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        </div>

        <Labelled label="Unit / Apt">
          <input
            className={ui.input}
            disabled={disabled}
            value={value.unit}
            onChange={(event) => handlePartInput('unit', event.target.value)}
            placeholder="Apt, Suite, Unit"
          />
        </Labelled>

        <Labelled label="City" required={required}>
          <input
            className={ui.input}
            disabled={disabled || readOnlySummary}
            value={value.city}
            onChange={(event) => handlePartInput('city', event.target.value)}
          />
        </Labelled>

        <Labelled label="State" required={required}>
          <input
            className={ui.input}
            disabled={disabled || readOnlySummary}
            value={value.state}
            onChange={(event) => handlePartInput('state', event.target.value)}
            maxLength={2}
          />
        </Labelled>

        <Labelled label="ZIP" required={required}>
          <input
            className={ui.input}
            disabled={disabled || readOnlySummary}
            value={value.zip}
            onChange={(event) => handlePartInput('zip', event.target.value)}
          />
        </Labelled>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        {value.verified ? (
          <span
            id="address-verified"
            className={`${ui.badge} ${ui.badgeTone.success}`}
          >
            <CheckCircle2 className="mr-1 h-3.5 w-3.5" />
            Address verified
          </span>
        ) : complete ? (
          <span className={`${ui.badge} ${ui.badgeTone.progress}`}>
            <MapPin className="mr-1 h-3.5 w-3.5" />
            Not verified
          </span>
        ) : null}
        {value.formatted ? (
          <span className="text-xs font-semibold text-slate-400">{value.formatted}</span>
        ) : null}
      </div>

      {showUnverifiedWarning ? (
        <p className="flex items-start gap-2 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-semibold text-amber-900">
          <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
          Choose this address from the suggestions so it can be verified. Typed
          addresses cannot be submitted.
        </p>
      ) : null}

      {showIncompleteHint ? (
        <p className="text-xs font-semibold text-slate-400">
          Keep typing and pick the address from the list to fill in city, state and ZIP.
        </p>
      ) : null}

      {lookupFailed ? (
        <p className="text-xs font-semibold text-rose-600">
          Address lookup is unavailable right now. Check the connection before submitting.
        </p>
      ) : null}

      {hint ? <p className="text-xs font-semibold text-slate-400">{hint}</p> : null}
    </div>
  );
}
