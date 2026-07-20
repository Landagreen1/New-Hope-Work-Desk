import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

/**
 * POST /api/address/validate
 * Validates a US address using the Google Address Validation API.
 * Returns the standardized/corrected address components.
 *
 * Requires GOOGLE_MAPS_API_KEY environment variable.
 */
export async function POST(request: Request) {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY || process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    console.error('[Address Validation] GOOGLE_MAPS_API_KEY is not set. Available env keys:', Object.keys(process.env).filter(k => k.includes('GOOGLE')));
    return NextResponse.json(
      { error: 'Address validation is not configured. Contact your administrator.' },
      { status: 503 },
    );
  }

  let body: { street: string; city: string; state: string; zip: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 });
  }

  const { street, city, state, zip } = body;
  if (!street || !zip) {
    return NextResponse.json({ error: 'Street and ZIP are required.' }, { status: 400 });
  }

  try {
    const response = await fetch(
      `https://addressvalidation.googleapis.com/v1:validateAddress?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          address: {
            regionCode: 'US',
            addressLines: [`${street}, ${city}, ${state} ${zip}`],
          },
          enableUspsCass: true,
        }),
      },
    );

    if (!response.ok) {
      const errData = await response.json().catch(() => ({}));
      console.error('Google Address Validation error:', errData);
      return NextResponse.json(
        { error: 'Address validation service returned an error.' },
        { status: 502 },
      );
    }

    const data = await response.json();
    const result = data?.result;
    const postalAddress = result?.address?.postalAddress;
    const verdict = result?.verdict;

    if (!postalAddress) {
      return NextResponse.json({ error: 'No address match found.' }, { status: 422 });
    }

    // Extract standardized components
    const addressComponents = result?.address?.addressComponents || [];
    const getComponent = (type: string) =>
      addressComponents.find((c: { componentType: string }) => c.componentType === type);

    const streetNumber = getComponent('street_number')?.componentName?.text || '';
    const route = getComponent('route')?.componentName?.text || '';
    const standardizedStreet = streetNumber && route ? `${streetNumber} ${route}` : postalAddress.addressLines?.[0] || street;

    const standardizedCity =
      getComponent('locality')?.componentName?.text || postalAddress.locality || city;
    const standardizedState =
      getComponent('administrative_area_level_1')?.componentName?.text ||
      postalAddress.administrativeArea || state;
    const standardizedZip =
      getComponent('postal_code')?.componentName?.text || postalAddress.postalCode || zip;

    return NextResponse.json({
      verified: verdict?.addressComplete === true || verdict?.validationGranularity === 'PREMISE' || verdict?.validationGranularity === 'SUB_PREMISE',
      street: standardizedStreet,
      city: standardizedCity,
      state: standardizedState,
      zip: standardizedZip,
      granularity: verdict?.validationGranularity || 'UNKNOWN',
      hasUnconfirmedComponents: verdict?.hasUnconfirmedComponents || false,
    });
  } catch (err) {
    console.error('Address validation fetch error:', err);
    return NextResponse.json(
      { error: 'Unable to reach address validation service.' },
      { status: 503 },
    );
  }
}
