// src/features/time-attendance/shared/SideDrawer.tsx
// The module's one drawer, and therefore the one place its focus behaviour is
// decided.
//
// `EmployeeDayDrawer`, `CoverageDateDrawer`, `RequestDecisionDrawer`, and
// `ExceptionDrawer` are all this component with different children. That is
// deliberate: Requirement 22, criteria 10 and 11 are about what happens to
// keyboard focus when a drawer opens and closes, and a rule spread across four
// components is four chances to get it wrong. Implemented once, focus cannot
// behave differently on the Review screen than it does on Today.
//
// ## What it does, criterion by criterion
//
// - **On open** it stores `document.activeElement` — the control the reader
//   pressed — and moves focus to the first focusable node inside the panel
//   (criterion 10). "First focusable" is a search, not `children[0]`: a drawer
//   whose first child is a heading still lands focus on the first control after
//   it. A drawer with no focusable content at all lands focus on the panel, which
//   carries `tabIndex={-1}` for exactly that case, so focus is never left behind
//   on the page underneath.
// - **While open** Tab and Shift+Tab are confined to the panel with a
//   wrap-around: past the last node Tab returns to the first, before the first
//   Shift+Tab returns to the last (criterion 10). A drawer holding a single
//   focusable node wraps to that node, so Tab is a no-op rather than an escape.
// - **On close** it returns focus to the stored control (criterion 11), but only
//   if that control is still in the document. A drawer opened from a table row
//   that the close then re-renders away would otherwise throw, or worse, focus a
//   detached node and leave the reader's focus nowhere.
// - **Escape closes.** The handler is on `document` rather than on the panel, so
//   it still fires if focus has somehow left the panel — after a click on the
//   scrim, say.
// - **Below 768 pixels** the panel is the full width and height of the viewport
//   (Requirement 22, criterion 3 and Requirement 7, criterion 3); at 768 and above
//   it is a side panel against the right edge.
//
// ## Movement is computed, not delegated
//
// The Tab handler always calls `preventDefault` and moves focus itself, rather
// than only intercepting the two boundaries and letting the browser handle the
// middle of the list. Two reasons: the behaviour is then identical in a browser
// and in a test that dispatches a `keydown` (jsdom moves no focus of its own), and
// focus sitting somewhere unexpected — on the panel, or on a node that has since
// been removed — still resolves to a node inside the drawer instead of falling
// through to the page. The cost is that a positive `tabindex` inside a drawer
// would be ignored: order here is DOM order. No drawer in the module uses one.
//
// Requirements: 22.2, 22.3, 22.10, 22.11

'use client';

import { X } from 'lucide-react';
import { useEffect, useId, useRef, type ReactNode } from 'react';

import { ui } from '../../nhwd-shared/ui';
import { COLOR_ROLE_TOKENS, MODAL_SCRIM, PANEL_SURFACE } from './tokens';

/**
 * What the browser will let a reader Tab to.
 *
 * `[tabindex]:not([tabindex="-1"])` picks up anything made focusable on purpose;
 * `-1` is excluded because it is the marker for "focusable by script only", which
 * is what the panel itself uses.
 */
const FOCUSABLE_SELECTOR = [
  'a[href]',
  'area[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'details > summary:first-of-type',
  'iframe',
  'audio[controls]',
  'video[controls]',
  '[contenteditable]:not([contenteditable="false"])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

/**
 * Nodes inside one of these are unreachable however focusable they look.
 *
 * Deliberately not a layout test: `offsetParent` and `getClientRects` report
 * nothing under jsdom, so a size check would call every node in a test invisible
 * and empty the focus list. These three attributes mean the same thing in a
 * browser and in a test.
 */
const UNREACHABLE_SELECTOR = '[hidden], [inert], [aria-hidden="true"]';

/**
 * The focusable nodes inside `container`, in the order Tab visits them.
 *
 * Exported because the drawer's focus order is worth asserting directly, and a
 * test that re-implemented this selector would be checking its own copy rather
 * than the one the component uses.
 */
export function focusableNodes(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter((node) => {
    // An `aria-hidden` wrapper *outside* the drawer says nothing about the
    // drawer's own content, so the walk up stops at the container.
    const blocker = node.closest(UNREACHABLE_SELECTOR);
    return blocker === null || !container.contains(blocker);
  });
}

export interface SideDrawerProps {
  /** Open state. The panel is unmounted while this is false. */
  open: boolean;
  /**
   * Called for the close button, Escape, and a click on the scrim. The caller
   * owns `open`, so nothing closes without the caller saying so.
   */
  onClose: () => void;
  /** The drawer's heading, and its accessible name. */
  title: string;
  /** Optional second line under the heading: the employee, the date, the request. */
  subtitle?: string;
  /**
   * Optional action row pinned below the scrolling content, for the decision and
   * correction controls the record drawers carry.
   */
  footer?: ReactNode;
  /** The record detail. Scrolls; the heading and the action row do not. */
  children: ReactNode;
}

/**
 * A record detail drawer.
 *
 * Requirements: 22.2, 22.3, 22.10, 22.11
 */
export function SideDrawer({ open, onClose, title, subtitle, footer, children }: SideDrawerProps) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const openerRef = useRef<Element | null>(null);
  const headingId = useId();
  const subtitleId = useId();

  // Criteria 10 and 11 as one effect: the store-and-enter on open is the same
  // event as the restore on close, so they cannot be kept in step by hand.
  useEffect(() => {
    if (!open) return;

    openerRef.current = document.activeElement;

    const panel = panelRef.current;
    if (panel !== null) {
      const first = focusableNodes(panel)[0] ?? panel;
      first.focus();
    }

    return () => {
      const opener = openerRef.current;
      openerRef.current = null;
      // Only if it is still there: the close may well have re-rendered the row
      // the drawer was opened from.
      if (opener instanceof HTMLElement && document.contains(opener)) opener.focus();
    };
  }, [open]);

  // Escape, and the Tab confinement. On `document` so a keystroke still lands
  // when focus is not inside the panel.
  useEffect(() => {
    if (!open) return;

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }

      if (event.key !== 'Tab') return;

      const panel = panelRef.current;
      if (panel === null) return;

      event.preventDefault();

      const nodes = focusableNodes(panel);
      if (nodes.length === 0) {
        panel.focus();
        return;
      }

      const active = document.activeElement;
      const current = active instanceof HTMLElement ? nodes.indexOf(active) : -1;

      // Focus outside the list — on the panel, or on nothing — enters at the end
      // the reader was heading for. One node is both ends, so it wraps to itself.
      const next = event.shiftKey
        ? current <= 0
          ? nodes.length - 1
          : current - 1
        : current === -1 || current === nodes.length - 1
          ? 0
          : current + 1;

      nodes[next].focus();
    }

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [open, onClose]);

  // Below 768 pixels the panel covers the viewport, so the page behind it must
  // not scroll under the reader's thumb.
  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, [open]);

  if (!open) return null;

  const neutral = COLOR_ROLE_TOKENS.neutral;

  return (
    <div className={`fixed inset-0 z-50 flex md:justify-end ${MODAL_SCRIM}`} onMouseDown={onClose}>
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        aria-describedby={subtitle === undefined ? undefined : subtitleId}
        tabIndex={-1}
        className={`flex h-full w-full flex-col shadow-2xl focus-visible:outline-none md:max-w-2xl md:border-l ${PANEL_SURFACE} ${neutral.border}`}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header
          className={`flex items-start justify-between gap-3 border-b px-4 py-4 sm:px-5 ${neutral.border}`}
        >
          <div className="min-w-0">
            <h2 id={headingId} className={`truncate text-base font-black ${neutral.text}`}>
              {title}
            </h2>
            {subtitle !== undefined ? (
              <p id={subtitleId} className={`mt-0.5 text-[13px] font-semibold ${neutral.text}`}>
                {subtitle}
              </p>
            ) : null}
          </div>
          <button type="button" className={ui.btnGhost} onClick={onClose}>
            <X className="h-4 w-4" aria-hidden="true" />
            Close
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-5">{children}</div>

        {footer !== undefined ? (
          <footer className={`border-t px-4 py-3 sm:px-5 ${neutral.border}`}>{footer}</footer>
        ) : null}
      </div>
    </div>
  );
}
