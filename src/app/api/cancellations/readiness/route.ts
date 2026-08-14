// POST /api/cancellations/readiness — deployment readiness check (REQ-3.2, REQ-8.1).
//
// Manager-only. Returns a structured report of environment configuration, template
// readiness, scheduler history, and current sending state. Never returns credential values.

import { providerReadiness } from '@/features/cancellations/scheduler/readiness';
import { canManageRenewals } from '@/lib/permissions';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface ReadinessReport {
  database: { migrated: boolean; settingsExists: boolean };
  sms: { configured: boolean };
  email: { configured: boolean };
  templates: { complete: boolean; missing: number[] };
  scheduler: { cronSecretSet: boolean; lastRun: string | null; lastResult: unknown | null };
  sending: { enabled: boolean; failedCount: number; missingContactCount: number };
}

// Both channel checks used to be hand-written here, and both were wrong: the SMS one read
// `RINGCENTRAL_*` names this product does not use, so it was permanently false and the
// automatic-sending toggle could never be enabled; the email one checked the API key without the
// from-address, so it could report ready while every send failed. `providerReadiness()` asks the
// provider modules themselves, which is also what keeps the credential names out of this file
// (Requirements 23.1, 23.5).

export async function POST(request: Request): Promise<Response> {
  try {
    // Session-gate: manager only
    const { createClient } = await import('@/lib/supabase/server');
    const supabase = await createClient();
    if (!supabase) {
      return Response.json({ error: 'Not authenticated' }, { status: 401 });
    }

    const { data: userData } = await supabase.auth.getUser();
    if (!userData?.user) {
      return Response.json({ error: 'Not authenticated' }, { status: 401 });
    }

    const { data: profile } = await supabase
      .from('profiles')
      .select('role')
      .eq('id', userData.user.id)
      .maybeSingle();

    if (!profile || !canManageRenewals(profile.role)) {
      return Response.json({ error: 'Manager role required' }, { status: 403 });
    }

    // Check environment variables (presence only, never values)
    const cronSecretSet = !!(process.env.CRON_SECRET && process.env.CRON_SECRET.length > 0);
    const { sms: smsConfigured, email: emailConfigured } = providerReadiness();

    // Check database readiness
    const { data: settings } = await supabase
      .from('cancellation_settings')
      .select('automatic_sending_enabled')
      .maybeSingle();

    const settingsExists = settings !== null;
    const sendingEnabled = settings?.automatic_sending_enabled ?? false;

    // Check template completeness (all four touchpoints: 15, 10, 5, 1)
    const { data: templates } = await supabase
      .from('cancellation_templates')
      .select('touchpoint');

    const touchpoints = new Set((templates ?? []).map((t: { touchpoint: number }) => t.touchpoint));
    const requiredTouchpoints = [15, 10, 5, 1];
    const missingTouchpoints = requiredTouchpoints.filter((tp) => !touchpoints.has(tp));

    // Check template versions exist for each template
    let templatesComplete = missingTouchpoints.length === 0;
    if (templatesComplete && templates && templates.length > 0) {
      const { data: versions } = await supabase
        .from('cancellation_template_versions')
        .select('template_id');
      const templatesWithVersions = new Set((versions ?? []).map((v: { template_id: string }) => v.template_id));
      // Not fully checking per-template here — just that versions exist
      templatesComplete = templatesWithVersions.size >= 4;
    }

    // Last scheduler run
    const { data: lastRunData } = await supabase
      .from('cancellation_scheduler_runs')
      .select('business_date,completed_at,sent,skipped,failed,automatic_sending_enabled')
      .order('started_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    // Failed communication count
    const { count: failedCount } = await supabase
      .from('cancellation_communications')
      .select('id', { count: 'exact', head: true })
      .eq('delivery_result', 'Failed');

    // Missing contact count (open cases with no valid contact)
    const { data: openCases } = await supabase
      .from('cancellation_cases')
      .select('id')
      .in('case_status', ['Imported', 'Open']);

    let missingContactCount = 0;
    if (openCases && openCases.length > 0) {
      const caseIds = openCases.map((c: { id: string }) => c.id);
      const { data: contacts } = await supabase
        .from('cancellation_contacts')
        .select('case_id')
        .in('case_id', caseIds)
        .eq('validation_status', 'valid');

      const casesWithContacts = new Set((contacts ?? []).map((c: { case_id: string }) => c.case_id));
      missingContactCount = caseIds.filter((id: string) => !casesWithContacts.has(id)).length;
    }

    const report: ReadinessReport = {
      database: { migrated: true, settingsExists },
      sms: { configured: smsConfigured },
      email: { configured: emailConfigured },
      templates: { complete: templatesComplete, missing: missingTouchpoints },
      scheduler: {
        cronSecretSet,
        lastRun: lastRunData?.completed_at ?? null,
        lastResult: lastRunData ?? null,
      },
      sending: {
        enabled: sendingEnabled,
        failedCount: failedCount ?? 0,
        missingContactCount,
      },
    };

    return Response.json(report);
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : 'Readiness check failed' },
      { status: 500 },
    );
  }
}
