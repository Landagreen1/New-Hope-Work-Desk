'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
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

// Load Google Maps script once globally
let googleMapsPromise: Promise<void> | null = null;

function loadGoogleMaps(apiKey: string): Promise<void> {
  if (googleMapsPromise) return googleMapsPromise;
  if (typeof window !== 'undefined' && window.google?.maps?.places) {
    return Promise.resolve();
  }
  googleMapsPromise = new Promise((resolve, reject) => {
    const existing = document.querySelector('script[src*="maps.googleapis.com"]');
    if (existing) { resolve(); return; }
    const script = document.createElement('script');
    script.src = `https://maps.googleapis.com/maps/api/js?key=${apiKey}&libraries=places`;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('Failed to load Google Maps'));
    document.head.appendChild(script);
  });
  return googleMapsPromise;
}

interface Suggestion {
  placeId: string;
  description: string;
}

export default function AddressAutocomplete({ defaultValue, disabled, onAddressSelected, onChange }: AddressAutocompleteProps) {
  const [inputValue, setInputValue] = useState(defaultValue);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [showDropdown, setShowDropdown] = useState(false);
  const [ready, setReady] = useState(false);
  const autocompleteService = useRef<google.maps.places.AutocompleteService | null>(null);
  const placesService = useRef<google.maps.places.PlacesService | null>(null);
  const dummyDiv = useRef<HTMLDivElement | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const apiKey = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY || 'AIzaSyAx1suQvn2_gb9fS4WpmFpFbfx5q1JaSV4';

  useEffect(() => {
    if (!apiKey || typeof window === 'undefined') return;
    loadGoogleMaps(apiKey)
      .then(() => {
        autocompleteService.current = new window.google.maps.places.AutocompleteService();
        if (!dummyDiv.current) {
          dummyDiv.current = document.createElement('div');
        }
        placesService.current = new window.google.maps.places.PlacesService(dummyDiv.current);
        setReady(true);
      })
      .catch(() => {});
  }, [apiKey]);

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

  const fetchSuggestions = useCallback((input: string) => {
    if (!ready || !autocompleteService.current || input.length < 3) {
      setSuggestions([]);
      return;
    }
    autocompleteService.current.getPlacePredictions(
      {
        input,
        componentRestrictions: { country: 'us' },
        types: ['address'],
      },
      (predictions, status) => {
        if (status === google.maps.places.PlacesServiceStatus.OK && predictions) {
          setSuggestions(predictions.map((p) => ({ placeId: p.place_id, description: p.description })));
          setShowDropdown(true);
        } else {
          setSuggestions([]);
        }
      },
    );
  }, [ready]);

  function handleInputChange(value: string) {
    setInputValue(value);
    onChange(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => fetchSuggestions(value), 300);
  }

  function handleSelect(suggestion: Suggestion) {
    setShowDropdown(false);
    setSuggestions([]);
    if (!placesService.current) return;

    placesService.current.getDetails(
      { placeId: suggestion.placeId, fields: ['address_components'] },
      (place, status) => {
        if (status !== google.maps.places.PlacesServiceStatus.OK || !place?.address_components) return;

        let streetNumber = '';
        let route = '';
        let unit: string | null = null;
        let city = '';
        let state = '';
        let zip = '';

        for (const component of place.address_components) {
          const types = component.types;
          if (types.includes('street_number')) streetNumber = component.long_name;
          else if (types.includes('route')) route = component.long_name;
          else if (types.includes('subpremise')) unit = component.long_name;
          else if (types.includes('locality') || types.includes('sublocality_level_1')) city = component.long_name;
          else if (types.includes('administrative_area_level_1')) state = component.short_name;
          else if (types.includes('postal_code')) zip = component.long_name;
        }

        const street = streetNumber && route ? `${streetNumber} ${route}` : route || streetNumber;
        setInputValue(street);
        onAddressSelected({ street, unit, city, state, zip });
      },
    );
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
              onClick={() => handleSelect(s)}
            >
              {s.description}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
