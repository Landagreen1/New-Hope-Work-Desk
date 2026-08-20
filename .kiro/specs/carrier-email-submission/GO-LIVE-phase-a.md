# Go live — Phase A

**Authored by:** Claude (Cowork), 20 August 2026
**Applies:** `v1.21.0-carrier-email-submission.sql` to project `kfbgftkjvtynfdwgcgeb`, then
merges `feat/carrier-email-submission` to `main`.

---

## First — why you are running this and not me

I could not apply it. This sandbox's network proxy refuses `api.supabase.com` outright
(`403 Tunnel connection failed`), and there is no shell tool pointed at your machine in
this session. So the token you authorised me to use was never usable for this. It stayed
in your `.env.local`; I read it once to check the project reference and nothing else.

That turns out to be the better outcome anyway — you watch the output live, and the
token never leaves your machine.

## What this changes on a live insurance database

Everything is additive. No table is dropped, no column is renamed, no existing row is
rewritten **except one**: `profiles.can_send_carrier_submissions` is set true where
`username = 'oscar'`.

Three new tables, four new columns on `market_directory`, one on `profiles`, one
function, and two values appended to the activity vocabulary. Nothing that currently
works can behave differently, because nothing currently reads any of it.

Verified against PostgreSQL 16 before you run it: applied, re-applied (idempotent),
probed, rolled back, and applied again. Your project is on 17.6 — a later version of the
same major line, and nothing here uses version-sensitive syntax.

---

## Step 1 — Back up

Supabase dashboard → **Database** → **Backups**. Take one, or confirm today's exists.

Skip this and the rollback in Step 5 still works, but you would be trusting a script
instead of a backup.

## Step 2 — Apply the migration

**Use the Supabase SQL editor**, not `run-sql.mjs`. The Management API returns result
sets but discards server notices, and this migration reports through `RAISE NOTICE`.

1. Dashboard → **SQL Editor** → **New query**
2. Paste the whole of `supabase/migrations/v1.21.0-carrier-email-submission.sql`
3. **Run**

### Two things about this editor, learned the hard way

**It shows only the LAST statement's result.** Paste five statements and you see one
table — the other four are silently discarded. This is why the diagnostic and the probe
were rewritten as one and two statements respectively.

**Notices may not surface at all.** The migration's `RAISE NOTICE` lines are best-effort.
Do not treat their absence as failure, and do not treat the lack of a visible error as
success. **Step 3 is the real check.**

### If it errors

The migration is wrapped in `begin; … commit;`, so any failure inside reverts everything
— you are left exactly where you started, with no partial state. Copy the error text and
send it to me. Then run `supabase/verification/v1.21.0-diagnostic.sql`, which is a single
statement and reports what exists and which dependency is missing.

## Step 3 — Verify

New query → paste `supabase/verification/v1.21.0-carrier-submission-probe.sql` → **Run**.

Two statements. The first exercises the write-path constraints and raises if any fail —
silence means it passed. The second returns the table you will actually see:

```
 check_name                                                | result
-----------------------------------------------------------+--------------------------
 table user_email_connections exists                        | PASS
 ...
 SECURITY: authenticated CANNOT read the token ciphertext   | PASS
 ...
 at least one profile may send                              | PASS
 who can send                                               | Oscar Landaverde
```

**Every row must read PASS**, and any that does not is flagged with `<-- LOOK AT THIS`.

Two rows matter most:

- **`SECURITY: authenticated CANNOT read the token ciphertext`** — if this says FAIL, stop
  and tell me. It would mean a browser session can read stored mailbox tokens, and Phase B
  must not proceed.
- **`who can send`** — should name you. If it says `(nobody)`, the `where username =
  'oscar'` seed matched nothing. The diagnostic's `usernames` row tells us what to use
  instead, and the migration is idempotent so re-running after a fix is safe.

The first statement writes rows and rolls them back inside a subtransaction. Nothing it
does persists.

## Step 4 — Merge and deploy

I have no write access to your repository, so these are yours to run.

```bash
cd "C:\Users\landa\Documents\New Hope Work Desk\New-Hope-Work-Desk"

# The Phase A files are sitting loose on main. Move them onto their own branch first.
git checkout -b feat/carrier-email-submission
git add -A
git commit -m "feat(specialty): carrier email submission — Phase A schema and data layer"

# Confirm nothing unexpected came along.
git show --stat HEAD          # expect 12 files: 11 + the rollback

git push -u origin feat/carrier-email-submission
```

Then either open a PR on GitHub, or merge straight to `main`:

```bash
git checkout main
git pull
git merge --no-ff feat/carrier-email-submission
git push
```

Vercel deploys `main` automatically. Watch the build — `next build` passed here in 28.5s
with no warnings, so a failure would mean something arrived that I did not see.

## Step 5 — If something goes wrong

`supabase/migrations/v1.21.0-rollback.sql`. Tested: applied, rolled back, re-applied
cleanly on the same database.

**It destroys submission history and stored mailbox connections.** Safe now, when both
are empty. Not safe once a real submission has been sent — at that point
`carrier_submissions` is the only record a carrier was ever emailed, and the script warns
you before it proceeds.

It deliberately leaves the two new activity event types in place. Rows may already carry
them, and a CHECK constraint cannot be added that rejects existing data.

---

## Step 6 — Confirm it landed

After the deploy, in the app: **User Administration → Market Directory → any market →
Submission tab**. You should see the enabled toggle, a CC field, subject and body
template boxes, and a list of the five placeholders.

Leave `email_submission_enabled` **off** for every carrier. Nothing can send yet —
turning it on now would only offer a Prepare Submission action that Phase B has not
built. Configure carriers once Phase B ships.

---

## Then tell me

- The `NOTICE` line from Step 2 — 1 profile or 0
- The § 2 row from Step 3
- Whether the Vercel build went green

And I will start Phase B: encryption helper, the Microsoft Graph module, the OAuth
routes, the settings screen, and the send endpoint.
