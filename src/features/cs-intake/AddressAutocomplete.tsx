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
  value: string;
  disabled?: boolean;
  onAddressSelected: (components: AddressComponents) => void;
  onChange: (value: string) => void;
}

// Load Google Maps script once
let googleMapsPromise: Promise<void> | null = null;

function loadGoogleMaps(apiKey: string): Promise<void> {
  if (googleMapsPromise) return googleMapsPromise;
  if (typeof window !== 'undefined' && window.google?.maps?.places) {
    googleMapsPromise = Promise.resolve();
    return googleMapsPromise;
  }
  googleMapsPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = `https://maps.googleapis.com/maps/api/js?key=${apiKey}&libraries=places`;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('Failed to load Google Maps'));
    document.head.appendChild(script);
  });
  return googleMapsPromise;
}

export default function AddressAutocomplete({ value, disabled, onAddressSelected, onChange }: AddressAutocompleteProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const autocompleteRef = useRef<google.maps.places.Autocomplete | null>(null);
  const [loaded, setLoaded] = useState(false);

  const apiKey = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY || '';

  useEffect(() => {
    if (!apiKey || typeof window === 'undefined') return;
    loadGoogleMaps(apiKey).then(() => setLoaded(true)).catch(() => {});
  }, [apiKey]);

  const initAutocomplete = useCallback(() => {
    if (!loaded || !inputRef.current || autocompleteRef.current) return;
    if (!window.google?.maps?.places) return;

    const autocomplete = new window.google.maps.places.Autocomplete(inputRef.current, {
      componentRestrictions: { country: 'us' },
      types: ['address'],
      fields: ['address_components', 'formatted_address'],
    });

    autocomplete.addListener('place_changed', () => {
      const place = autocomplete.getPlace();
      if (!place.address_components) return;

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
      onAddressSelected({ street, unit, city, state, zip });
    });

    autocompleteRef.current = autocomplete;
  }, [loaded, onAddressSelected]);

  useEffect(() => {
    initAutocomplete();
  }, [initAutocomplete]);

  return (
    <input
      ref={inputRef}
      className={ui.input}
      disabled={disabled}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder="Start typing an address…"
      autoComplete="off"
    />
  );
}
