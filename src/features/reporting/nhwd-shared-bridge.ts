/**
 * Re-export of the shared UI tokens under a path the reporting components can reach
 * from both the feature root and its `components/` and `views/` subdirectories without
 * every file carrying a different number of `../` segments.
 *
 * Purely a convenience. The tokens themselves live in
 * `src/features/nhwd-shared/ui.ts` and are unchanged.
 */

export { ui, statusLabel } from '../nhwd-shared/ui';
