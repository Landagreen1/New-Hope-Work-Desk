# Design: Fix null id on cs_intake_drivers insert

## Problem

When a customer service agent submits an intake quote via `saveDraft()` in `src/features/cs-intake/api.ts`, inserting rows into `cs_intake_drivers` (and `cs_intake_vehicles`) fails with:

> null value in column "id" of relation "cs_intake_drivers" violates not-null constraint

## Root Cause

In the `saveDraft` function (line ~255), drivers are inserted like this:

```typescript
drivers.map((driver, index) => ({
  ...driver,
  id: undefined,
  submission_id: id,
  position: index + 1,
}))
```

Setting `id: undefined` still includes the `id` key in the resulting object. When Supabase's PostgREST client serializes this to JSON for the PostgreSQL insert, the `undefined` value becomes `null`. PostgreSQL then uses the explicit `null` instead of the column's default (`gen_random_uuid()`), violating the NOT NULL constraint.

The same pattern exists for `cs_intake_vehicles` insertion (line ~266).

## Solution

Remove the `id` key from the insert payload entirely (rather than setting it to `undefined`) so PostgreSQL's default UUID generation takes effect.

### Approach: Destructure to omit `id`

Replace the spread-then-override pattern with destructuring that excludes `id`:

```typescript
drivers.map(({ id: _id, ...rest }, index) => ({
  ...rest,
  submission_id: id,
  position: index + 1,
}))
```

Apply the same fix to the vehicles insert block.

## Files Changed

| File | Change |
|------|--------|
| `src/features/cs-intake/api.ts` | Remove `id` from driver and vehicle insert payloads using destructuring |

## Testing

- Verify that saving a draft with drivers no longer throws the null constraint error
- Verify that the inserted rows receive auto-generated UUIDs
- Verify that updating an existing draft (re-save) still works correctly (delete + re-insert pattern)
