# Tasks: Fix null id on cs_intake_drivers insert

## Task 1: Fix driver insert payload to omit id field [done: false]

### Description
In `src/features/cs-intake/api.ts`, in the `saveDraft` function, change the driver insert mapping to destructure out the `id` field instead of setting it to `undefined`.

### Sub-tasks
- [x] In the drivers insert block (~line 255), replace `{ ...driver, id: undefined, submission_id: id, position: index + 1 }` with destructuring: `({ id: _id, ...rest }, index) => ({ ...rest, submission_id: id, position: index + 1 })`
- [x] Also remove `submission_id` from the spread if present (it's already being explicitly set), by destructuring it out: `({ id: _id, submission_id: _sid, ...rest }, index) => ({ ...rest, submission_id: id, position: index + 1 })`

## Task 2: Fix vehicle insert payload to omit id field [done: false]

### Description
Apply the same destructuring fix to the vehicles insert block in `saveDraft`.

### Sub-tasks
- [x] In the vehicles insert block (~line 266), replace `{ ...vehicle, id: undefined, submission_id: id, position: index + 1 }` with destructuring: `({ id: _id, submission_id: _sid, ...rest }, index) => ({ ...rest, submission_id: id, position: index + 1 })`

## Task 3: Verify TypeScript compilation [done: false]

### Description
Run the TypeScript compiler to confirm there are no type errors after the changes.

### Sub-tasks
- [x] Run `npx tsc --noEmit` and verify zero errors related to the changed file
