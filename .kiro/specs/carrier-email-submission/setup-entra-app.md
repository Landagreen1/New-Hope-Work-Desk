# Setup: Microsoft Entra app registration + encryption key

**For:** Oscar · **Task 0.2** in `tasks.md` · **Blocks Phase B**
**Time:** about 20 minutes
**Authored by:** Claude (Cowork), 20 August 2026

This produces five values. Phase B of the carrier email submission feature cannot start without
them. Phase 0.1 and Phase A can proceed in parallel — they do not depend on this.

---

## Before you start — two things to know

**1. Never paste the client secret or the encryption key into a chat, an email, or a commit.**
Not to me, not to Kiro. They go in exactly two places: `.env.local` on your machine, and Vercel's
environment variables. I do not need to see them — the code reads them from the environment. If you
ever need to confirm a value is set, tell me "it's set" and that is enough.

**2. You need to know your production URL.** Open your Vercel dashboard, select the New Hope Work
Desk project, and look at the Domains section. It is either a `*.vercel.app` address or a custom
domain like `workdesk.newhopeinsurance.com`. Write it down now — you will need it in Step 4.

Throughout this document, `YOUR-DOMAIN` means that address.

---

## Part 1 — Register the application

### Step 1: Open the Entra admin center

Go to **https://entra.microsoft.com** and sign in with your `olanda@nhpfs.com` account.

If sign-in fails or you land somewhere without an **Entra ID** menu, you are not a tenant
administrator. Stop here and tell me — the plan changes (someone with admin rights has to do Parts
1–3, or we use a different approach).

### Step 2: Create the registration

1. In the left menu, select **Entra ID**.
2. Select **App registrations**.
3. Select **New registration**.

Fill in:

| Field | Value |
|---|---|
| **Name** | `New Hope Work Desk` |
| **Supported account types** | **Single tenant only — <your tenant>** (the first option) |
| **Redirect URI** | Leave blank. You will add two in Step 4. |

Select **Register**.

> **Why single tenant:** only accounts in your own organization should ever be able to authorize
> this app. The multi-tenant options exist for software sold to other companies.

### Step 3: Copy the two identifiers

You land on the **Overview** page. Copy these two values — neither is a secret, both are safe to
store in a config file:

- **Application (client) ID** → this becomes `MS_OAUTH_CLIENT_ID`
- **Directory (tenant) ID** → this becomes `MS_OAUTH_TENANT_ID`

Both are UUIDs, formatted like `a1b2c3d4-e5f6-7890-abcd-ef1234567890`.

---

## Part 2 — Redirect URIs

### Step 4: Add both redirect URIs

1. Under **Manage**, select **Authentication**.
2. On the **Redirect URI configuration** tab, select **Add Redirect URI**.
3. On the **Select a platform to add redirect URI** pane, select the **Web** tile.
4. Enter your production URI:

   ```
   https://YOUR-DOMAIN/api/email-connections/microsoft/callback
   ```

5. Leave **Front-channel logout URL** blank.
6. Select **Configure**.

Now add the local development one. Back on the **Authentication** page, under the **Web** platform
you just created, select **Add URI** and enter:

```
http://localhost:3000/api/email-connections/microsoft/callback
```

Select **Save**.

> **These must match character for character** — including `https` vs `http`, the trailing path, and
> no trailing slash. A mismatch produces `AADSTS50011: The redirect URI specified in the request
> does not match the redirect URIs configured for the application`, which is the single most common
> failure in this setup. `localhost` is the one address allowed to use plain `http`.

---

## Part 3 — Permissions

### Step 5: Add the three delegated permissions

1. Under **Manage**, select **API permissions**.
2. Select **Add a permission**.
3. Select **Microsoft Graph**.
4. Select **Delegated permissions** — *not* Application permissions. This matters. See the note
   below.
5. In the search box, find and tick each of these:
   - `Mail.Send`
   - `User.Read`
   - `offline_access`
6. Select **Add permissions**.

> **Delegated vs Application, and why it matters here.** Delegated means the app acts *as you*,
> with your consent, limited to what you can already do — it can send from your mailbox and nothing
> else. Application permissions would let the app send as *any* mailbox in the organization without
> a user present. We want delegated. If you accidentally grant `Mail.Send` as an Application
> permission, remove it.

`User.Read` is there for one reason: after you authorize, the app calls it once to learn which
mailbox you actually connected, so the settings screen can show you the real address rather than
one we assumed. `offline_access` is what returns a refresh token — without it, the connection would
die within an hour and you would have to re-authorize constantly.

**Amended 21 August 2026 — `Mail.ReadWrite` is also required.** The submission is composed as a
draft in your own mailbox before it is sent, and Microsoft Graph requires `Mail.ReadWrite` for
that call. `Mail.Send` on its own authorises only a fire-and-forget send that returns no message
identifier, so a submission could never prove it went out. Add `Mail.ReadWrite` alongside the other
three.

What is still refused: the `.Shared` and `.All` variants, which would reach other people's
mailboxes, and application permissions, which would let the server send as anyone with no user
present. A test fails the build if either appears.

### Step 6: Admin consent — try it, but it is optional

On the same **API permissions** page, look for **Grant admin consent for <your organization>**.

**If the button is available**, select it and confirm. The **Status** column turns to a green
**Granted for <your organization>** on all three rows. Done.

**If the button is greyed out, skip it and continue to Step 7.** This is common and it does not
block the feature.

Granting tenant-wide admin consent requires one of these directory roles: Privileged Role
Administrator, Cloud Application Administrator, Application Administrator, or AI Administrator. A
greyed-out button means the signed-in account holds none of them.

That matters less than it looks. Admin consent pre-approves an application **for every user in the
organization at once** — a rollout convenience, not a functional requirement. All three permissions
this app requests are ones an individual user may consent to for themselves:

| Permission | Admin consent required? |
|---|---|
| `Mail.Send` (delegated) | No |
| `User.Read` (delegated) | No |
| `offline_access` | No |

Phase 1 has a single sender. When that person connects their mailbox they are shown a consent
screen, they accept, and consent is recorded against their own account. That is sufficient.

The only configuration that would block this is a tenant with user consent switched off entirely by
policy, which is not the Microsoft 365 default. **Step 7 detects that case in about thirty seconds**
— it surfaces as `AADSTS90094`, and it is the one outcome that genuinely requires an administrator.

---

## Part 4 — Client secret

### Step 7: Create the secret

1. Under **Manage**, select **Certificates & secrets**.
2. Select the **Client secrets** tab.
3. Select **New client secret**.
4. Fill in:
   - **Description**: `Work Desk carrier email — created Aug 2026`
   - **Expires**: choose **24 months** (the longest the portal offers)
5. Select **Add**.

### Step 8: Copy the Value immediately

The table now shows two columns that are easy to confuse:

| Column | What it is | Do you need it? |
|---|---|---|
| **Value** | The actual secret. A long random string. | **Yes — this is `MS_OAUTH_CLIENT_SECRET`.** |
| **Secret ID** | A UUID identifying the secret record. | No. Ignore it. |

**Copy the Value now.** It is displayed exactly once. Navigate away, refresh, or close the blade and
it is masked forever — your only option then is to delete the secret and create another.

If you copy the Secret ID by mistake, authentication fails with `AADSTS7000215: Invalid client
secret provided`. It looks like a valid credential, which is what makes the mistake easy.

### Step 9: Write down the expiry date

The secret you just made stops working in 24 months — around **August 2028**. When it expires,
sending fails and the fix is not obvious from the error.

Put a calendar reminder for **one month before** that date, titled something like *"Rotate Work Desk
Entra client secret."* Do it now while you are thinking about it. This is the kind of thing that
takes down a working feature two years later and costs an afternoon to diagnose.

---

## Part 5 — Encryption key

### Step 10: Generate it

This key encrypts your stored mailbox tokens. It is not a Microsoft value — you generate it, and it
never leaves your control.

Open a terminal in the repo folder and run:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Or, in PowerShell:

```powershell
$b = New-Object byte[] 32
[System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b)
[Convert]::ToBase64String($b)
```

Either produces a 44-character string ending in `=`, like
`kJ8vQ2mN4pR7sT1wY5zA8bC3dE6fG9hI0jK2lM4nO6Q=`. That is `EMAIL_TOKEN_ENCRYPTION_KEY`.

Both methods use a cryptographically secure random generator. Do **not** substitute a password you
thought of, or `Get-Random`, or an online generator.

> **What losing this key means.** Every stored mailbox connection becomes undecryptable and you have
> to reconnect. That is the whole point — it is why a stolen database backup is useless without it.
> Your submission history is unaffected; only the connection is. Keep a copy somewhere you trust,
> such as a password manager, separate from the database.

---

## Part 6 — Install the values

### Step 11: Local — `.env.local`

Add these five lines to `.env.local` in the repo root. Substitute your real values.

```
# Microsoft 365 mailbox connection for carrier submissions
MS_OAUTH_CLIENT_ID=<Application (client) ID from Step 3>
MS_OAUTH_CLIENT_SECRET=<the Value from Step 8>
MS_OAUTH_TENANT_ID=<Directory (tenant) ID from Step 3>
MS_OAUTH_REDIRECT_URI=http://localhost:3000/api/email-connections/microsoft/callback

# AES-256-GCM key for encrypting stored mailbox tokens
EMAIL_TOKEN_ENCRYPTION_KEY=<the base64 string from Step 10>
```

`.env.local` is already in `.gitignore`, so none of this can reach the public repository. I verified
that during the audit — no credential has ever been committed to this repo.

Note the local `MS_OAUTH_REDIRECT_URI` uses **localhost**, while production uses your domain. Same
variable, different value per environment. That is why both URIs had to be registered in Step 4.

### Step 12: Production — Vercel

In the Vercel dashboard: your project → **Settings** → **Environment Variables**. Add the same five,
with one difference:

```
MS_OAUTH_REDIRECT_URI=https://YOUR-DOMAIN/api/email-connections/microsoft/callback
```

Set all five for **Production** and **Preview**. None of them carries a `NEXT_PUBLIC_` prefix, and
none of them ever should — that prefix would inline the value into the browser bundle and publish
your client secret to anyone who opens developer tools.

Redeploy after adding them. Environment variables are read at runtime, but a fresh deploy is the
reliable way to be sure the new values are live.

---

## Part 7 — Confirm it worked

You cannot fully test until Phase B is built. But you can confirm the registration is sound right
now, in about a minute.

Paste this into your browser's address bar, substituting your client ID and tenant ID, and press
Enter:

```
https://login.microsoftonline.com/<TENANT_ID>/oauth2/v2.0/authorize?client_id=<CLIENT_ID>&response_type=code&redirect_uri=http%3A%2F%2Flocalhost%3A3000%2Fapi%2Femail-connections%2Fmicrosoft%2Fcallback&response_mode=query&scope=https%3A%2F%2Fgraph.microsoft.com%2FMail.Send%20https%3A%2F%2Fgraph.microsoft.com%2FUser.Read%20offline_access
```

**What should happen:** you sign in, and land on a Microsoft consent screen listing *Send mail as
you*, *Sign you in and read your profile*, and *Maintain access to data you have given it access
to*. It then redirects to a `localhost:3000` address that fails to load, because nothing is running
there yet.

**That failure is the success.** It means Entra accepted the client ID, the tenant, the redirect
URI, and all three scopes. Everything Phase B needs is correct.

**If instead you see an error**, tell me the `AADSTS` code — it names the exact problem:

| Code | Meaning | Fix |
|---|---|---|
| `AADSTS50011` | Redirect URI mismatch | Step 4 — compare character for character |
| `AADSTS700016` | Application not found in tenant | Wrong client ID or wrong tenant ID |
| `AADSTS65001` | Permissions not saved | Step 5 — recheck the three delegated permissions |
| `AADSTS90094` | Tenant requires admin consent | The one case that needs an administrator — see Step 6 |
| `AADSTS7000215` | Invalid client secret | Not this test, but Step 8 — you copied the Secret ID |

---

## What to tell me when you are done

Just this, with nothing sensitive in it:

- [ ] App registered, single tenant
- [ ] Both redirect URIs added
- [ ] Three delegated permissions added and admin consent granted (green ticks)
- [ ] Client secret created, Value copied, expiry reminder set
- [ ] Encryption key generated
- [ ] All five variables in `.env.local` and in Vercel
- [ ] The Part 7 test reached the consent screen
- [ ] Your production domain (this one I do need, for the docs)

Then Phase B is unblocked.
