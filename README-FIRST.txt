NEW HOPE WORK DESK v0.9.1 UI PATCH

No Supabase SQL migration is required.

Replace these files in the current GitHub-connected project:
- src/components/work-desk-app.tsx
- src/components/login-form.tsx
- package.json
- package-lock.json

Add:
- UPGRADE-v0.9.1.md

Then run:
1. npm run lint
2. npx tsc --noEmit
3. npm run build
4. git add .
5. git commit -m "Redesign reports and simplify login"
6. git push origin main
