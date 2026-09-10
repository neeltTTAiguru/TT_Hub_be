# Who can reach what

Signing in and being allowed everywhere are two different questions, answered in
two different places.

| Question | Answered by | Where |
| --- | --- | --- |
| May this person sign in at all? | Auth0 Login Action + `ALLOWED_EMAIL_DOMAINS` | `restrict-to-trusted-domains.js`, `src/middleware/auth.js` |
| Once in, what may they touch? | `FULL_ACCESS_EMAILS` | `src/middleware/featureAccess.js` |
| May they manage users? | `ADMIN_EMAILS` / `User.isAdmin` | `src/routes/admin.js` |
| May they open the Hermes droplet dashboard? | `HERMES_DASHBOARD_ALLOWED_EMAILS` | `src/services/hermesDashboard.js` |

## The feature gate

`requireFeatureAccess` runs on every authenticated request, immediately after
`requireAuth`. Accounts on `FULL_ACCESS_EMAILS` pass straight through. Everybody
else may reach exactly three routers:

- `/le-agencies` — the Agency Map: the agency layer, the traveller and his chat,
  briefings, SDR forms, call logs, research runs.
- `/crm-deals` — the deal pins on that same map.
- `/brevo` — the Brevo email agent: lists, senders, campaigns.

Everything else answers 403. The list is of routers rather than endpoints on
purpose: a new endpoint added to one of the two features keeps working, and a
new router is closed until someone adds it here deliberately.

`GET /access` sits above the gate and reports `{ email, fullAccess }`. The
sidebar asks it on load and hides what this account cannot use — cosmetic only,
since the pages behind those links would 403 anyway.

## Setting it

```
FULL_ACCESS_EMAILS=neel@trustedtechnology.ai,todd.hodnett@trustedtechnology.ai
```

Comma-separated, case-insensitive, full addresses (no bare `@domain` — this is
meant to be a short list of people, not a domain).

**Unset means Neel alone**, not everyone. That is deliberate: a backend that
comes up without the variable should fail towards less access. It also means
production must have the variable set explicitly — the DigitalOcean app's
environment is not in this repo, so deploying the code without setting it there
leaves everyone but Neel restricted.

## Things that are outside the gate

- `/health`, `/email-assets`, `/content-operations-download/:token` are mounted
  before `requireAuth` and stay public. Email assets are fetched by mail clients
  with no session; the download route is a signed capability URL.
- `POST /hermes-session` is behind `requireAuth` but not behind this gate, since
  proxy-only mode exists to serve Hermes. It has its own fail-closed allowlist,
  `HERMES_DASHBOARD_ALLOWED_EMAILS`, and is granted separately on purpose: it
  proxies to the dashboard on the Hermes droplet, which is nearer to a shell on
  that box than to a page in this app. It currently matches `FULL_ACCESS_EMAILS`
  (Neel and Todd), but it is a deliberate second decision each time rather than
  something that follows from full hub access, and it should never be longer
  than `FULL_ACCESS_EMAILS`.
