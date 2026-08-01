// src/features/time-attendance/shared/idempotency.ts
// The module's idempotency keys, in one place.
//
// Three write endpoints take one — `/api/attendance/corrections`,
// `/api/attendance/notes`, and `/api/pto/decisions` — and all three treat a
// repeated key the same way: the change applies once, and a second arrival
// answers with the prior result and `applied: false` (Requirements 10.17, 12.16,
// 14.2). That contract only works if a key identifies *one composed change*, so
// the rule for a caller is the same everywhere: mint a key when the form opens,
// keep it across a retry, and mint a fresh one once the change is in place.
//
// Here rather than in each drawer so the two drawers that submit corrections and
// decisions cannot end up with different notions of what a key is.
//
// Requirements: 10.17, 12.16

'use client';

/**
 * A key no two composed changes share.
 *
 * `crypto.randomUUID` where the runtime has it, which is every secure context
 * this app is served from. The fallback is for a non-secure context, and it is
 * unique enough for what the key is asked to do: tell one submission from
 * another within one drawer, over the seconds a retry takes.
 */
export function newIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `ta-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
