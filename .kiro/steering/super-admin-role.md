# Super Admin Role Parity Rule

The `super_admin` role inherits ALL permissions, views, and access that the `manager` role has. Any code that checks for `role === 'manager'` MUST also include `role === 'super_admin'`.

## Pattern

Whenever you write a manager role check, always include super_admin:

```tsx
// UI components
const isManager = profile.role === 'manager' || profile.role === 'super_admin';

// API routes
if (profile?.role !== "manager" && profile?.role !== "super_admin") {
  return Response.json({ error: "..." }, { status: 403 });
}

// RLS policies (SQL)
(select role from public.profiles where id = auth.uid()) in ('manager', 'super_admin')
```

## Key Differences (super_admin ONLY)

These capabilities are exclusive to super_admin and are NOT shared with managers:

- Creating or assigning the `super_admin` role to other users
- Managing payment rates, hourly pay, and payroll settings
- Managing clock-in edits, time-off approvals, and work schedules
- Super admin accounts CANNOT be deleted by anyone (including other super admins)

## When NOT to apply

- Test files: only update tests if the test is specifically testing role-based access
- If a feature is explicitly documented as super_admin-only, do NOT grant it to managers
