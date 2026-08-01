// src/features/time-attendance/shared/tokens.ts
// The six colour roles of Requirement 22, criterion 5, and the classes each one
// renders as.
//
// This is the module's whole palette. A screen that needs a colour reads a role
// from here; it never writes `bg-emerald-50` itself. That is what makes
// Requirement 22, criterion 5 checkable in one place instead of being a
// convention four screens have to remember, and it is why `StatusPill`,
// `CoverageBadge`, and the health ribbon cannot render the same meaning in two
// different colours.
//
// Pure data: no React, no I/O, no imports. `domain/presentation.ts` imports it
// to fill in the surface and text classes of a `StatusToken`, and the domain
// layer stays pure because there is nothing here to make impure.
//
// ## The roles
//
// | role       | palette          | meaning (criterion 5)                                    |
// | ---------- | ---------------- | -------------------------------------------------------- |
// | `neutral`  | slate            | normal information                                       |
// | `accent`   | `#223f7a`        | the selected item and the primary action                 |
// | `healthy`  | emerald          | staffing above requirement                               |
// | `warning`  | amber            | staffing approaching minimum                             |
// | `critical` | rose             | staffing below minimum, and Payroll_Blocking records     |
// | `pending`  | violet           | items awaiting review                                    |
//
// `accent` is the brand colour already used for the primary button and the focus
// ring in `nhwd-shared/ui.ts`, so the module's selected state matches the rest of
// the desk rather than introducing a second blue.
//
// ## Contrast
//
// Requirement 22, criterion 13 asks for status text at 4.5 to 1 or better
// against the surface it sits on, so each role pairs a light surface with text
// dark enough to clear that ratio against *its own* surface — the pairing is
// fixed here rather than chosen per call site, which is the only way the ratio
// can be guaranteed for every status.
//
// `surfaceHex` and `textHex` carry the sRGB values of those two classes so the
// ratio can be computed rather than asserted. The measured ratios are:
//
// | role       | surface                | text                    | ratio    |
// | ---------- | ---------------------- | ----------------------- | -------- |
// | `neutral`  | `slate-100`  `#f1f5f9` | `slate-700`   `#334155` | 9.4 to 1 |
// | `accent`   | `#eef3fb`              | `#223f7a`               | 9.1 to 1 |
// | `healthy`  | `emerald-50` `#ecfdf5` | `emerald-700` `#047857` | 5.2 to 1 |
// | `warning`  | `amber-50`   `#fffbeb` | `amber-800`   `#92400e` | 6.8 to 1 |
// | `critical` | `rose-50`    `#fff1f2` | `rose-700`    `#be123c` | 5.7 to 1 |
// | `pending`  | `violet-50`  `#f5f3ff` | `violet-700`  `#6d28d9` | 6.5 to 1 |
//
// Warning takes the 800 weight rather than the 700 the other roles use. Amber is
// the lightest of the four hues at any given weight, and `amber-700` on
// `amber-50` measures 4.8 to 1 — over the bar, but with no headroom for a later
// palette adjustment. It is also the weight `ui.ts` already uses for its amber
// badge tone.
//
// Requirements: 22.5, 22.6, 22.13

/**
 * The six colour roles. Every colour the module renders is one of these.
 *
 * `accent` is the odd one out: it marks the selected item and the primary
 * action, which are interaction states rather than statuses. `statusToken` never
 * returns it — see `domain/presentation.ts`.
 */
export type ColorRole = 'neutral' | 'accent' | 'healthy' | 'warning' | 'critical' | 'pending';

/** Every role, in the order Requirement 22, criterion 5 names them. */
export const COLOR_ROLES: readonly ColorRole[] = [
  'neutral',
  'accent',
  'healthy',
  'warning',
  'critical',
  'pending',
];

/**
 * One role's classes, and the two colour values behind them.
 *
 * `surface` and `text` are the pair criterion 13 constrains, and they are the
 * two a `StatusToken` carries. `border`, `ring`, and `dot` are the same role
 * expressed for the other places a colour appears — a calendar cell's edge, a
 * pill's hairline, a ribbon's indicator dot — so a caller needing one of those
 * still does not pick a palette.
 */
export interface ColorRoleToken {
  role: ColorRole;
  /** What the role means, in the words of Requirement 22, criterion 5. */
  meaning: string;
  /** The Tailwind palette family, or the brand hex for `accent`. */
  palette: string;
  surface: string;
  text: string;
  border: string;
  ring: string;
  dot: string;
  /** sRGB value of `surface`, so criterion 13's ratio can be computed. */
  surfaceHex: string;
  /** sRGB value of `text`. */
  textHex: string;
}

/**
 * The token table: the one mapping from a colour role to classes.
 *
 * Requirements: 22.5, 22.13
 */
export const COLOR_ROLE_TOKENS: Record<ColorRole, ColorRoleToken> = {
  neutral: {
    role: 'neutral',
    meaning: 'normal information',
    palette: 'slate',
    surface: 'bg-slate-100',
    text: 'text-slate-700',
    border: 'border-slate-200',
    ring: 'ring-slate-200',
    dot: 'bg-slate-400',
    surfaceHex: '#f1f5f9',
    textHex: '#334155',
  },
  accent: {
    role: 'accent',
    meaning: 'the selected item and the primary action',
    palette: '#223f7a',
    surface: 'bg-[#eef3fb]',
    text: 'text-[#223f7a]',
    border: 'border-[#c9d5e9]',
    ring: 'ring-[#c9d5e9]',
    dot: 'bg-[#223f7a]',
    surfaceHex: '#eef3fb',
    textHex: '#223f7a',
  },
  healthy: {
    role: 'healthy',
    meaning: 'staffing above requirement',
    palette: 'emerald',
    surface: 'bg-emerald-50',
    text: 'text-emerald-700',
    border: 'border-emerald-200',
    ring: 'ring-emerald-200',
    dot: 'bg-emerald-500',
    surfaceHex: '#ecfdf5',
    textHex: '#047857',
  },
  warning: {
    role: 'warning',
    meaning: 'staffing approaching minimum',
    palette: 'amber',
    surface: 'bg-amber-50',
    text: 'text-amber-800',
    border: 'border-amber-200',
    ring: 'ring-amber-200',
    dot: 'bg-amber-500',
    surfaceHex: '#fffbeb',
    textHex: '#92400e',
  },
  critical: {
    role: 'critical',
    meaning: 'staffing below minimum, and payroll-blocking records',
    palette: 'rose',
    surface: 'bg-rose-50',
    text: 'text-rose-700',
    border: 'border-rose-200',
    ring: 'ring-rose-200',
    dot: 'bg-rose-500',
    surfaceHex: '#fff1f2',
    textHex: '#be123c',
  },
  pending: {
    role: 'pending',
    meaning: 'items awaiting review',
    palette: 'violet',
    surface: 'bg-violet-50',
    text: 'text-violet-700',
    border: 'border-violet-200',
    ring: 'ring-violet-200',
    dot: 'bg-violet-500',
    surfaceHex: '#f5f3ff',
    textHex: '#6d28d9',
  },
};

/** The classes of one role. A lookup, named so call sites read as intent. */
export function colorRoleToken(role: ColorRole): ColorRoleToken {
  return COLOR_ROLE_TOKENS[role];
}

// ─── Modal surfaces ──────────────────────────────────────────────────────────
//
// A drawer panel and the scrim behind it are not statuses, so they carry no
// colour role. They are still colours, though, and the whole point of this file
// is that a component never picks one for itself — so the two live here beside
// the roles rather than inside `SideDrawer.tsx`, and the module's one drawer and
// any later confirmation overlay cannot end up with two different scrims.

/**
 * The scrim behind a drawer or a destructive confirmation.
 *
 * Half-opaque slate rather than plain black: it is the same treatment the desk's
 * existing overlays use, so the module's drawer sits on the page the way the rest
 * of the app's overlays do.
 */
export const MODAL_SCRIM = 'bg-slate-950/50 backdrop-blur-sm';

/** A raised surface: the drawer panel, and anything else lifted off the page. */
export const PANEL_SURFACE = 'bg-white';

// ─── Pill shell ──────────────────────────────────────────────────────────────

/**
 * The two pill sizes. `sm` is the table-row and calendar-cell size; `md` is for
 * a pill carrying a region of its own, such as a drawer heading.
 */
export type PillSize = 'sm' | 'md';

/** Shape, spacing, and weight shared by every pill, whatever its role. */
const PILL_BASE = 'inline-flex items-center gap-1.5 rounded-full font-black ring-1 whitespace-nowrap';

const PILL_PADDING: Record<PillSize, string> = {
  sm: 'px-2 py-0.5 text-[11px]',
  md: 'px-2.5 py-1 text-xs',
};

/** Icon dimensions per pill size, so the glyph tracks the text. */
export const PILL_ICON_SIZE: Record<PillSize, string> = {
  sm: 'h-3 w-3',
  md: 'h-3.5 w-3.5',
};

/**
 * The full class string for a pill in one role.
 *
 * `StatusPill` and `CoverageBadge` both call this, so the two cannot drift into
 * looking like different components for the same status.
 */
export function pillClassName(role: ColorRole, size: PillSize = 'sm', className?: string): string {
  const token = COLOR_ROLE_TOKENS[role];
  const classes = [PILL_BASE, PILL_PADDING[size], token.surface, token.text, token.ring];
  if (className !== undefined && className !== '') classes.push(className);
  return classes.join(' ');
}
