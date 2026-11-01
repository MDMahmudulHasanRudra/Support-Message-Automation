# My account — self-service profile and sign-in security

Every signed-in person has **My account**. It lives at `/account`, outside every project, and is reached from the user menu in a project's header. Inside the Main Admin Portal the same view is at `/admin/account` (sidebar → My account). Both render `components/account/AccountView.tsx`.

| Section | What the person can do | What it needs |
|---|---|---|
| Profile | Change their name, email (optional, unique), phone, and photo | Nothing more |
| Username | Choose a new username (3–40 characters: `a-z 0-9 . _ -`, globally unique) | Current password |
| Password | Set a new password (12+ characters, not the username); optionally sign out other devices (on by default) | Current password |
| Two-step sign-in | Turn on TOTP (RFC 6238) and receive 10 one-time recovery codes; make new codes; turn it off | Password to start; code to confirm; code to make new recovery codes; password **and** code to turn off |
| Devices | See every live session (this device marked); sign out one device or all others | Nothing more |
| Recent activity | See their last 30 sign-in and account events | Nothing more |

## Rules worth not undoing

- **Self only.** Every action in `server/actions/account.ts` takes the user from the session, never from the form, so none needs a permission key.
  - A support identity (`supportOperatorId`, or a support session) can change nothing.
- **A wrong current password counts toward the sign-in lockout** (`server/loginLockout.ts`, shared with the login page). A stolen session cannot guess the password through My account any faster than at the sign-in page.
- **Two-step sign-in at login:**
  - The code is asked only after every other check has passed (password, active, address), so asking reveals nothing a wrong password would not.
  - A code is claimed by a conditional update: its time step must be newer than `mfaLastUsedStep`, and a recovery code must still be in the list. One code therefore signs in at most once, even if it is sent twice at the same moment.
  - A wrong code counts toward the lockout.
- **Secrets:**
  - The TOTP secret is an `encryptSecret` envelope.
  - A setup that has not been confirmed with a code is held in `mfaPendingSecretCiphertext` and never signs anyone in.
  - Recovery codes are stored only as SHA-256 hashes and shown once.
- **Administrator reset:** Main Admin → Users & Permissions → a user → "Reset two-step sign-in".
  - Needs `users.edit`.
  - Never applies to the administrator's own login.
  - `privilegeRefusal` applies, so only a Main Admin can reset a Main Admin.
  - Signs the person out everywhere.
- **Photo:** sniffed and stripped with `prepareClientPhoto` (JPEG, PNG or WebP, ≤ 200 KB, also a database CHECK), resized to 256 px in the browser, stored in `UserAvatar` (its own table, so the bytes are never loaded with a User). It is served only by `/api/account/avatar/<userId>` to the person themselves or a signed-in person of the same customer, with `private` cache and a sandbox CSP.
- **Activity** is the System Log, filtered to the person:
  - events they triggered (`actorUserId`);
  - an administrator's reset of their password or two-step sign-in (`targetType = "User"`, `targetId` = them).

  `LOGIN_SUCCESS` now records the IP address and user agent.
- `passwordChangedAt` is stamped by every password change: self-service, administrator resets, and the platform's reset.

## Migration

`20261101100000_account_self_service` is additive:

- **User:** adds `phone`, `passwordChangedAt`, `usernameChangedAt` and the `mfa*` columns.
- **New table:** `UserAvatar`.
- **Employee email:** unique per customer (two partial indexes) instead of across every customer.

Deploy it with `docker compose run --rm migrate` before the app.
