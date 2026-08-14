// @vitest-environment jsdom
// A collector export dropped into the eficacia/avisos wizard (v1.14.x).
//
// Both consolidated collector files have fixed headers and are imported from Policy follow-up →
// Imports. Dropped into this wizard they were refused by `classifyImportFile` with "the header row
// names neither cancellation report format" — accurate, and useless: the file is perfectly
// importable one surface over, and the message left a manager to work that out.
//
// `eficacia` already disallows `PolizaNormalizada` on purpose, because a collector file merged under
// eficacia field ownership would silently drop the fields only the collector carries. That refusal
// was right; it was just incomplete. These tests pin the answer that completes it.
//
// The renewals wizard has the mirror of this in `renewals/__tests__/bulk-assign.test.tsx`.

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AppRole } from '@/lib/types';
import CancellationManagerActions from '../CancellationManagerActions';

const MANAGER_ROLES: readonly AppRole[] = ['manager', 'super_admin'];

/** The 24-column consolidated cancellations collector export. */
const CANCELLATION_COLLECTOR_CSV = [
  'Compania,Poliza,PolizaNormalizada,Asegurado,LOB,FechaCancelacion,FechaCancelacionEstimada,'
  + 'FechaVencimientoPago,MontoAdeudado,TipoTransaccion,EstadoCarrier,TipoRegistro,ClienteID,Titular,'
  + 'Telefonos,Emails,EstadoHawkSoft,Productor,Idioma,Cruce,MetodoCruce,ArchivoOrigen,FilaOrigen,'
  + 'AvisosImportacion',
  'Progressive,ZZTEST-C-001,ZZTEST-C-001,ZZ TEST ALPHA,Personal Auto,2026-08-29,,2026-08-27,412.55,'
  + 'Cancelacion por falta de pago,Pendiente,pending,ZZT001,ZZ TEST ALPHA,9158083304,a@b.com,Active,'
  + 'ZZ TEST PRODUCER ONE,es,Exacto,ClienteID,zz.csv,2,note',
].join('\n');

/** The 26-column consolidated renewals collector export. */
const RENEWAL_COLLECTOR_CSV = [
  'Compania,Poliza,PolizaNormalizada,Asegurado,LOB,TerminoMeses,FechaRenovacion,FechaVencimiento,'
  + 'FechaProcesada,PrimaRenovacion,PrimaAnterior,TipoRegistro,EstadoEnReporte,ClienteID,Titular,'
  + 'Telefonos,Emails,EstadoHawkSoft,ActivaEnHawkSoft,PrimaHawkSoft,Productor,Cruce,MetodoCruce,'
  + 'ArchivoOrigen,FilaOrigen,AvisosImportacion',
  'Progressive,ZZTEST-R-001,ZZTEST-R-001,ZZ TEST ALPHA,Personal Auto,12,2026-08-16,2026-08-16,'
  + '2026-08-14,1450.00,1200.00,Renovacion,Renewal Offered,ZZR001,ZZ TEST ALPHA,9158083304,a@b.com,'
  + 'Active,Si,1200.00,ZZ TEST PRODUCER ONE,Exacto,ClienteID,zz.csv,2,note',
].join('\n');

/** A real eficacia report, which this wizard does import and must keep importing. */
const EFICACIA_CSV = [
  'Cliente,Poliza,Compania,FechaCancelacion,MontoDebido,Enviar,Estado,Resultado,AvisosEnviados,'
  + 'PrimerAviso,UltimoAviso,Productor,ClienteID',
  'Maria Garcia,POL-2026-001,Mapfre,2026-08-15,1250.00,Si,Pendiente,,0,,,Roberto Martinez,CL-001',
].join('\n');

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

/** Opens the collapsed control, then the import panel, matching the sibling suite's helper. */
function openImport() {
  fireEvent.click(screen.getByRole('button', { name: /Show manager actions/ }));
  fireEvent.click(screen.getByRole('button', { name: /Import cancellation report/ }));
}

async function chooseFile(text: string, name: string) {
  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  await act(async () => {
    fireEvent.change(input, { target: { files: [new File([text], name, { type: 'text/csv' })] } });
  });
}

describe('a collector export in the eficacia/avisos wizard', () => {
  it.each(MANAGER_ROLES)('names it and says where it goes, for %s', async (role) => {
    render(<CancellationManagerActions role={role} />);
    openImport();
    await chooseFile(CANCELLATION_COLLECTOR_CSV, 'consolidado_cancelaciones.csv');

    const status = screen.getByRole('status').textContent ?? '';
    expect(status).toContain('consolidado_cancelaciones.csv is the consolidated cancellations collector export');
    expect(status).toContain('Policy follow-up → Imports');
    // Not the old refusal, which named no way forward.
    expect(screen.queryByText(/names neither cancellation report format/)).toBeNull();
  });

  it('does not advance to classification or mapping', async () => {
    render(<CancellationManagerActions role="manager" />);
    openImport();
    await chooseFile(CANCELLATION_COLLECTOR_CSV, 'consolidado_cancelaciones.csv');

    expect(screen.queryByText('Classification result')).toBeNull();
    expect(screen.queryByText('Column mapping')).toBeNull();
  });

  it('names the mistake when the renewals collector file is dropped here', async () => {
    render(<CancellationManagerActions role="manager" />);
    openImport();
    await chooseFile(RENEWAL_COLLECTOR_CSV, 'consolidado_renovaciones.csv');

    const status = screen.getByRole('status').textContent ?? '';
    expect(status).toContain('consolidated renewals collector export');
    expect(status).toContain('This is the renewals file, not the cancellations one');
  });

  it('still classifies a real eficacia report', async () => {
    render(<CancellationManagerActions role="manager" />);
    openImport();
    await chooseFile(EFICACIA_CSV, 'eficacia.csv');

    expect(screen.getByText('Classification result')).toBeTruthy();
    expect(screen.queryByText(/collector export/)).toBeNull();
  });

  it('clears the notice when an eficacia report is chosen next', async () => {
    render(<CancellationManagerActions role="manager" />);
    openImport();
    await chooseFile(CANCELLATION_COLLECTOR_CSV, 'consolidado_cancelaciones.csv');
    expect(screen.getByRole('status').textContent).toContain('collector export');

    await chooseFile(EFICACIA_CSV, 'eficacia.csv');
    expect(screen.getByText('Classification result')).toBeTruthy();
  });
});
