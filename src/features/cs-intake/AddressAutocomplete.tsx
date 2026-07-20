'use client';

import { useCallback, useEffect, useRef } from 'react';
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
let googleMapsLoaded = false;

function loadGoogleMaps(apiKey: string): Promise<void> {
  if (googleMapsLoaded) return Promise.resolve();
  if (googleMapsPromise) return googleMapsPromise;
  if (typeof window !== 'undefined' && window.google?.maps?.places) {
    googleMapsLoaded = true;
    return Promise.resolve();
  }
  googleMapsPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = `https://maps.googleapis.com/maps/api/js?key=${apiKey}&libraries=places`;
    script.async = true;
    script.onload = () => { googleMapsLoaded = true; resolve(); };
    script.onerror = () => reject(new Error('Failed to load Google Maps'));
    document.head.appendChild(script);
  });
  return googleMapsPromise;
}

export default function AddressAutocomplete({ defaultValue, disabled, onAddressSelected, onChange }: AddressAutocompleteProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const autocompleteRef = useRef<google.maps.places.Autocomplete | null>(null);
  const onAddressSelectedRef = useRef(onAddressSelected);
  onAddressSelectedRef.current = onAddressSelected;

  const apiKey = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY || '';

  const initAutocomplete = useCallback(() => {
    if (!inputRef.current || autocompleteRef.current) return;
    if (!window.google?.maps?.places) return;

    const autocomplete = new window.google.maps.places.Autocomplete(inputRef.current, {
      componentRestrictions: { country: 'us' },
      types: ['address'],
      fields: ['address_components'],
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

      // Update the input display value
      if (inputRef.current) {
        inputRef.current.value = street;
      }

      onAddressSelectedRef.current({ street, unit, city, state, zip });
    });

    autocompleteRef.current = autocomplete;
  }, []);

  useEffect(() => {
    if (!apiKey || typeof window === 'undefined') return;
    loadGoogleMaps(apiKey).then(() => initAutocomplete()).catch(() => {});
  }, [apiKey, initAutocomplete]);

  return (
    <input
      ref={inputRef}
      className={ui.input}
      disabled={disabled}
      defaultValue={defaultValue}
      onChange={(e) => onChange(e.target.value)}
      placeholder="Start typing an address…"
      autoComplete="off"
    />
  );
}
