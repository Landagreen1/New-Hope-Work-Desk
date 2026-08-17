/**
 * Verified address state, and the rules that decide when a verification survives
 * an edit.
 *
 * Kept separate from the React component on purpose: "does this address still
 * count as verified?" is the part that carries risk, and it has to be provable
 * without a browser, a DOM, or a Google API key.
 *
 * The rule that matters: an address is verified because a human picked a real
 * place out of the Google suggestions, not because the text looks like an
 * address. So typing over a verified street, city, state or ZIP throws the
 * verification away. Editing the apartment or unit does not, because Google does
 * not resolve unit numbers reliably and an apartment number is not part of what
 * was verified.
 */

/** A structured address plus the evidence that it was actually verified. */
export interface VerifiedAddressValue {
  street: string;
  /** Apartment, suite, or unit. Deliberately outside the verified set. */
  unit: string;
  city: string;
  state: string;
  zip: string;
  /** Google Place ID of the selected place, when one was selected. */
  placeId: string | null;
  /** The single-line address Google returned for the selected place. */
  formatted: string | null;
  /** True only while the current street/city/state/ZIP are the ones Google returned. */
  verified: boolean;
}

/** What a Google Places selection gives us back, already unpacked. */
export interface PlaceSelection {
  street: string;
  unit: string | null;
  city: string;
  state: string;
  zip: string;
  placeId: string | null;
  formatted: string | null;
}

/**
 * The address components that a manual edit invalidates.
 *
 * `unit` is absent by design — see the note at the top of this file.
 */
export const VERIFIED_ADDRESS_PARTS = ['street', 'city', 'state', 'zip'] as const;

export type VerifiedAddressPart = (typeof VERIFIED_ADDRESS_PARTS)[number];

/** Every editable field, including the one that does not affect verification. */
export type VerifiedAddressField = VerifiedAddressPart | 'unit';

export function emptyVerifiedAddress(): VerifiedAddressValue {
  return {
    street: '',
    unit: '',
    city: '',
    state: '',
    zip: '',
    placeId: null,
    formatted: null,
    verified: false,
  };
}

/** True when the field is one whose edit destroys a verification. */
export function invalidatesVerification(field: VerifiedAddressField): boolean {
  return (VERIFIED_ADDRESS_PARTS as readonly string[]).includes(field);
}

/**
 * Applies a Google Places selection.
 *
 * The unit is only taken from Google when Google actually supplied one
 * (`subpremise`); an existing hand-typed apartment number is otherwise kept,
 * because the employee usually types it before searching the street.
 */
export function applyPlaceSelection(
  current: VerifiedAddressValue,
  place: PlaceSelection,
): VerifiedAddressValue {
  return {
    street: place.street,
    unit: place.unit ?? current.unit,
    city: place.city,
    state: place.state,
    zip: place.zip,
    placeId: place.placeId,
    formatted: place.formatted,
    verified: true,
  };
}

/**
 * Applies a manual edit, dropping the verification when the edited field was
 * part of what Google verified.
 *
 * This is what stops `123 Main St` being edited to `129 Main St` and still
 * displaying as verified.
 */
export function applyManualEdit(
  current: VerifiedAddressValue,
  field: VerifiedAddressField,
  value: string,
): VerifiedAddressValue {
  const next: VerifiedAddressValue = { ...current, [field]: value };

  if (!invalidatesVerification(field)) return next;
  if (current[field] === value) return next;

  return { ...next, verified: false, placeId: null, formatted: null };
}

/** True when every required part has a value. Says nothing about verification. */
export function isAddressComplete(value: VerifiedAddressValue): boolean {
  return (
    value.street.trim() !== '' &&
    value.city.trim() !== '' &&
    value.state.trim() !== '' &&
    value.zip.trim() !== ''
  );
}

/** True only when the address is both complete and still carries its verification. */
export function isAddressVerified(value: VerifiedAddressValue): boolean {
  return value.verified && isAddressComplete(value);
}

/**
 * Derives a rental-property address from the customer's address.
 *
 * The derived address inherits the customer address's verification rather than
 * claiming one of its own: it is the same physical place, so it is exactly as
 * verified as the address it was copied from — no more, no less. That is why
 * ticking "Same as Customer Address" on an unverified customer address does not
 * produce a verified rental address.
 */
export function deriveFromCustomerAddress(
  customer: VerifiedAddressValue,
): VerifiedAddressValue {
  return {
    street: customer.street,
    unit: customer.unit,
    city: customer.city,
    state: customer.state,
    zip: customer.zip,
    placeId: customer.placeId,
    formatted: customer.formatted,
    verified: customer.verified,
  };
}
