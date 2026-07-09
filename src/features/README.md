# Feature modules

Future internal tools should be added as self-contained feature folders instead of expanding `work-desk-app.tsx` indefinitely.

Recommended structure:

```text
src/features/<module-name>/
  components/
  lib/
  types.ts
  README.md
```

Each module should:

1. Own its UI components and business helpers.
2. Use shared authentication from `src/lib/supabase`.
3. Register its navigation metadata in `src/platform/module-registry.ts`.
4. Add database changes only through a new numbered Supabase migration.
5. Reuse central `profiles`, notifications, and audit concepts when appropriate.
6. Avoid importing another module's internal component directly; expose a small public interface instead.

The current Work Desk remains fully functional while future code is extracted incrementally into this structure.
