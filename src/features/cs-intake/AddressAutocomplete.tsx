'use client';

import { useEffect, useRef, useState } from 'react';
import { ui } from '../nhwd-shared/ui';

interface AddressComponents {
  street: string;
  unit: string | null;
  city: string;
  state: string;
  zip: string;
}

interface AddressAutocompleteProps {
  defaultValue: string;
  disabled?: boolean;
  onAddressSelected: (components: AddressComponents) => void;
  onChange: (value: string) => void;
}

const API_KEY = 'AIzaSyC4u00lSMI5AEXrDRlo_HrO8x7la5LiHeY';

// Load Google Maps script once globally
let loadPromise: Promise<void> | null = null;

function ensureGoogleMaps(): Promise<void> {
  if (typeof window === 'undefined') return Promise.reject();
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

export default function AddressAutocomplete({ defaultValue, disabled, onAddressSelected, onChange }: AddressAutocompleteProps) {
  const [inputValue, setInputValue] = useState(defaultValue);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [showDropdown, setShowDropdown] = useState(false);
  const [ready, setReady] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sessionTokenRef = useRef<google.maps.places.AutocompleteSessionToken | null>(null);

  useEffect(() => {
    ensureGoogleMaps().then(() => setReady(true)).catch(() => {});
  }, []);

  // Close dropdown on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setShowDropdown(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  function getSessionToken() {
    if (!sessionTokenRef.current) {
      sessionTokenRef.current = new google.maps.places.AutocompleteSessionToken();
    }
    return sessionTokenRef.current;
  }

  async function fetchSuggestions(input: string) {
    if (!ready || input.length < 3) {
      setSuggestions([]);
      return;
    }

    try {
      // Use the new Place Autocomplete API
      const { suggestions: results } = await google.maps.places.AutocompleteSuggestion.fetchAutocompleteSuggestions({
        input,
        sessionToken: getSessionToken(),
        includedRegionCodes: ['us'],
        includedPrimaryTypes: ['street_address', 'subpremise', 'premise'],
      });

      if (results?.length) {
        setSuggestions(
          results
            .filter((r) => r.placePrediction)
            .map((r) => ({
              placeId: r.placePrediction!.placeId,
              text: r.placePrediction!.text.text,
            }))
        );
        setShowDropdown(true);
      } else {
        setSuggestions([]);
      }
    } catch {
      // Fallback: try without includedPrimaryTypes (broader results)
      try {
        const { suggestions: results } = await google.maps.places.AutocompleteSuggestion.fetchAutocompleteSuggestions({
          input,
          sessionToken: getSessionToken(),
          includedRegionCodes: ['us'],
        });

        if (results?.length) {
          setSuggestions(
            results
              .filter((r) => r.placePrediction)
              .map((r) => ({
                placeId: r.placePrediction!.placeId,
                text: r.placePrediction!.text.text,
              }))
          );
          setShowDropdown(true);
        } else {
          setSuggestions([]);
        }
      } catch {
        setSuggestions([]);
      }
    }
  }

  function handleInputChange(value: string) {
    setInputValue(value);
    onChange(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => void fetchSuggestions(value), 300);
  }

  async function handleSelect(suggestion: Suggestion) {
    setShowDropdown(false);
    setSuggestions([]);

    try {
      const place = new google.maps.places.Place({ id: suggestion.placeId });
      await place.fetchFields({ fields: ['addressComponents'] });

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
        else if (types.includes('locality') || types.includes('sublocality_level_1')) city = component.longText || '';
        else if (types.includes('administrative_area_level_1')) state = component.shortText || '';
        else if (types.includes('postal_code')) zip = component.longText || '';
      }

      const street = streetNumber && route ? `${streetNumber} ${route}` : route || streetNumber;
      setInputValue(street);

      // Reset session token after a selection
      sessionTokenRef.current = null;

      onAddressSelected({ street, unit, city, state, zip });
    } catch {
      // If Place details fail, at least set the text
      setInputValue(suggestion.text.split(',')[0] || suggestion.text);
    }
  }

  return (
    <div ref={containerRef} className="relative">
      <input
        className={ui.input}
        disabled={disabled}
        value={inputValue}
        onChange={(e) => handleInputChange(e.target.value)}
        onFocus={() => { if (suggestions.length) setShowDropdown(true); }}
        placeholder="Start typing an address…"
        autoComplete="off"
      />
      {showDropdown && suggestions.length > 0 && (
        <ul className="absolute left-0 right-0 top-full z-50 mt-1 max-h-60 overflow-auto rounded-xl border border-slate-200 bg-white py-1 shadow-lg">
          {suggestions.map((s) => (
            <li
              key={s.placeId}
              className="cursor-pointer px-4 py-2.5 text-sm font-semibold text-slate-700 hover:bg-[#eef3fb] hover:text-[#223f7a]"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => void handleSelect(s)}
            >
              {s.text}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
