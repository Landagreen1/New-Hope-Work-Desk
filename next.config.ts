import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /**
   * Opt the two export libraries out of Server Component bundling so they load through
   * native Node `require` at runtime.
   *
   * Spec: .kiro/specs/sales-reporting-center-redesign, Requirement 18.2
   *
   * `pdfkit` depends on `fontkit`, whose ESM build imports `applyDecoratedDescriptor`
   * from `@swc/helpers` under a name that package no longer exports. Turbopack resolves
   * that statically and fails the build. Both packages are Node-only and are used
   * exclusively inside `src/app/api/reports/sales/export/route.ts`, which already
   * declares `runtime = 'nodejs'`, so there is nothing to gain from bundling them and
   * the documented opt-out is the right fix rather than a workaround.
   */
  serverExternalPackages: ["pdfkit", "exceljs"],
};

export default nextConfig;
