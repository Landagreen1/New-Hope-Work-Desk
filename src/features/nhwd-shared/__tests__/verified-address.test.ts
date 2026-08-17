/**
 * Address verification.
 *
 * The rule under test: an address counts as verified because a human picked a real
 * place out of the Google suggestions, never because the text looks like an
 * address. Every case below is one of the five Renters scenarios the redesign
 * requires, plus the invariants that make them hold.
 */

import { describe, expect, it } from 'vitest';

import {
  applyManualEdit,
  applyPlaceSelection,
  deriveFromCustomerAddress,
  emptyVerifiedAddress,
  invalidatesVerification,
  isAddressComplete,
  isAddressVerified,
  VERIFIED_ADDRESS_PARTS,
  type PlaceSelection,
  type VerifiedAddressValue,
} from '../verified-address';

/** A place as Google returns it. */
const GASTONIA: PlaceSelection = {
  street: '123 Main St',
  unit: null,
  city: 'Gastonia',
  state: 'NC',
  zip: '28054',
  placeId: 'place-gastonia-123-main',
  formatted: '123 Main St, Gastonia, NC 28054, USA',
};

const CHARLOTTE: PlaceSelection = {
  street: '400 Tryon St',
  unit: null,
  city: 'Charlotte',
  state: 'NC',
  zip: '28202',
  placeId: 'place-charlotte-400-tryon',
  formatted: '400 Tryon St, Charlotte, NC 28202, USA',
};

/** A verified customer address, the starting point for most cases. */
function verifiedCustomerAddress(): VerifiedAddressValue {
  return applyPlaceSelection(emptyVerifiedAddress(), GASTONIA);
}

describe('what a verification is', () => {
  it('starts unverified and incomplete', () => {
    const empty = emptyVerifiedAddress();
    expect(empty.verified).toBe(false);
    expect(isAddressComplete(empty)).toBe(false);
    expect(isAddressVerified(empty)).toBe(false);
  });

  it('records the place id and formatted address as the evidence', () => {
    const address = verifiedCustomerAddress();
    expect(address.verified).toBe(true);
    expect(address.placeId).toBe(GASTONIA.placeId);
    expect(address.formatted).toBe(GASTONIA.formatted);
    expect(isAddressVerified(address)).toBe(true);
  });

  it('populates the structured parts from the selection rather than leaving them typed', () => {
    // Renters Test 3: selecting a valid Google result fills the structured address.
    const address = verifiedCustomerAddress();
    expect(address).toMatchObject({
      street: '123 Main St',
      city: 'Gastonia',
      state: 'NC',
      zip: '28054',
    });
  });

  it('does not treat complete text as verified', () => {
    // Renters Test 2: the employee typed a full, plausible address but never
    // selected it. Complete, yes. Verified, no.
    let typed = emptyVerifiedAddress();
    typed = applyManualEdit(typed, 'street', '129 Main St');
    typed = applyManualEdit(typed, 'city', 'Gastonia');
    typed = applyManualEdit(typed, 'state', 'NC');
    typed = applyManualEdit(typed, 'zip', '28054');

    expect(isAddressComplete(typed)).toBe(true);
    expect(typed.verified).toBe(false);
    expect(isAddressVerified(typed)).toBe(false);
  });
});

describe('editing a verified address', () => {
  it('invalidates the verification when the street is changed afterwards', () => {
    // Renters Test 4, and the exact example from the requirement: 123 Main St is
    // verified, the employee edits it to 129, and it must stop showing as verified.
    const edited = applyManualEdit(verifiedCustomerAddress(), 'street', '129 Main St');

    expect(edited.street).toBe('129 Main St');
    expect(edited.verified).toBe(false);
    expect(edited.placeId).toBeNull();
    expect(edited.formatted).toBeNull();
  });

  it('invalidates on any of the parts Google actually returned', () => {
    for (const part of VERIFIED_ADDRESS_PARTS) {
      const edited = applyManualEdit(verifiedCustomerAddress(), part, 'something else');
      expect(invalidatesVerification(part)).toBe(true);
      expect(edited.verified).toBe(false);
    }
  });

  it('keeps the verification when only the apartment or unit changes', () => {
    // Renters Test 5. Google does not resolve unit numbers reliably and a unit is
    // not part of what was verified, so typing one must not throw the
    // verification away — otherwise every apartment dweller is unverifiable.
    const withUnit = applyManualEdit(verifiedCustomerAddress(), 'unit', 'Apt 4B');

    expect(invalidatesVerification('unit')).toBe(false);
    expect(withUnit.unit).toBe('Apt 4B');
    expect(withUnit.verified).toBe(true);
    expect(withUnit.placeId).toBe(GASTONIA.placeId);
    expect(isAddressVerified(withUnit)).toBe(true);
  });

  it('survives a no-op edit that sets a part to the value it already had', () => {
    // Re-rendering a controlled input must not silently unverify an address.
    const address = verifiedCustomerAddress();
    const unchanged = applyManualEdit(address, 'street', address.street);
    expect(unchanged.verified).toBe(true);
    expect(unchanged.placeId).toBe(address.placeId);
  });

  it('restores the verification when a new place is selected', () => {
    const edited = applyManualEdit(verifiedCustomerAddress(), 'street', '400 Tr');
    expect(edited.verified).toBe(false);

    const reselected = applyPlaceSelection(edited, CHARLOTTE);
    expect(reselected.verified).toBe(true);
    expect(reselected.placeId).toBe(CHARLOTTE.placeId);
    expect(reselected.city).toBe('Charlotte');
  });

  it('keeps a hand-typed unit when the selected place does not supply one', () => {
    // Employees usually type the apartment number before searching the street.
    let address = applyManualEdit(emptyVerifiedAddress(), 'unit', 'Apt 12');
    address = applyPlaceSelection(address, GASTONIA);
    expect(address.unit).toBe('Apt 12');
    expect(address.verified).toBe(true);
  });

  it('prefers the unit Google returned when there is one', () => {
    const address = applyPlaceSelection(emptyVerifiedAddress(), {
      ...GASTONIA,
      unit: 'Unit 7',
    });
    expect(address.unit).toBe('Unit 7');
  });
});

describe('Same as Customer Address', () => {
  it('copies the verified customer address and inherits its verification', () => {
    // Renters Test 1: customer address verified, rental marked same as customer,
    // submission succeeds — which requires the derived address to be verified.
    const customer = verifiedCustomerAddress();
    const rental = deriveFromCustomerAddress(customer);

    expect(rental).toEqual(customer);
    expect(isAddressVerified(rental)).toBe(true);
  });

  it('does not manufacture a verification from an unverified customer address', () => {
    // Ticking the box cannot be a way to bypass verification. The derived address
    // is exactly as verified as the one it came from, no more.
    let typed = emptyVerifiedAddress();
    typed = applyManualEdit(typed, 'street', '129 Main St');
    typed = applyManualEdit(typed, 'city', 'Gastonia');
    typed = applyManualEdit(typed, 'state', 'NC');
    typed = applyManualEdit(typed, 'zip', '28054');

    const rental = deriveFromCustomerAddress(typed);
    expect(isAddressComplete(rental)).toBe(true);
    expect(rental.verified).toBe(false);
    expect(isAddressVerified(rental)).toBe(false);
  });

  it('carries the apartment across, since a rental unit matters to the risk', () => {
    const customer = applyManualEdit(verifiedCustomerAddress(), 'unit', 'Apt 4B');
    expect(deriveFromCustomerAddress(customer).unit).toBe('Apt 4B');
  });

  it('produces an independent copy, so later customer edits do not silently move the rental', () => {
    const customer = verifiedCustomerAddress();
    const rental = deriveFromCustomerAddress(customer);
    const movedCustomer = applyManualEdit(customer, 'street', '999 Elsewhere Rd');

    expect(rental.street).toBe('123 Main St');
    expect(movedCustomer.street).toBe('999 Elsewhere Rd');
  });
});

describe('completeness is not verification', () => {
  it('requires every part before calling an address complete', () => {
    const base = verifiedCustomerAddress();
    for (const part of VERIFIED_ADDRESS_PARTS) {
      expect(isAddressComplete({ ...base, [part]: '' })).toBe(false);
    }
    expect(isAddressComplete({ ...base, unit: '' })).toBe(true);
  });

  it('treats whitespace as absent, so a space cannot satisfy a required part', () => {
    expect(isAddressComplete({ ...verifiedCustomerAddress(), city: '   ' })).toBe(false);
  });

  it('never reports an incomplete address as verified even if the flag is set', () => {
    // Defence in depth: a flag surviving a partial clear must not read as verified.
    const contradictory: VerifiedAddressValue = { ...verifiedCustomerAddress(), zip: '' };
    expect(contradictory.verified).toBe(true);
    expect(isAddressVerified(contradictory)).toBe(false);
  });
});
