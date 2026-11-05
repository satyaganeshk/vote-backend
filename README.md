# Vote Backend

Secure, role-based REST API that powers a single-vote democratic election system, built as a demo for the **District Election Commission — East Godavari (Andhra Pradesh)**.

It enforces the hard rules of a real election: every voter must be explicitly authorized before they can vote, every voter gets exactly **one** vote, votes can never be changed or retracted, and individual ballots are never traceable back to a voter (secret ballot) — only aggregate tallies are exposed.

## Tech stack

| Concern              | Library                                   |
| -------------------- | ------------------------------------------ |
| HTTP server          | [Express 4](https://expressjs.com/) (TypeScript, ESM) |
| Database             | [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) — embedded SQLite, WAL journal mode |
| Auth                 | [jsonwebtoken](https://github.com/auth0/node-jsonwebtoken) (1-hour bearer tokens) |
| Password hashing     | [bcryptjs](https://github.com/dcodeIO/bcrypt.js) |
| OTP delivery         | [EmailJS REST API](https://www.emailjs.com) (voter one-time sign-in codes) |
| Cross-origin requests | [cors](https://github.com/expressjs/cors) |
| Dev runtime          | [tsx](https://github.com/privatenumber/tsx) (watch mode) |

## Domain model — three roles, three different logins

| Role          | How they sign in              | What they can do |
| ------------- | ------------------------------ | ----------------- |
| **VOTER**     | Voter ID + a one-time code emailed to their registered address | View the approved candidate list and cast **exactly one** vote, once authorized by an Admin. Login is disabled entirely once they've voted. |
| **CANDIDATE** | Email + password               | View their own nomination profile and live vote count; edit manifesto, party symbol, and photos. New candidates can self-nominate and start out `PENDING`. |
| **ADMIN**     | Email + password                | Approve/revoke voter eligibility, approve/reject candidate nominations, nominate candidates on anyone's behalf, and view live, anonymized turnout + results. |

### Why it's "secure by design"

- **Single-vote invariant** — casting a vote is one atomic SQLite transaction: it flips `users.has_voted`, writes a `vote_audit_log` row, and increments `candidate_vote_counts` together. The server re-checks `has_voted`/`is_approved_voter` from the database on every request (not just the JWT) to close race conditions.
- **Secret ballot** — there is no column anywhere that links a `vote_audit_log` row to *which candidate* a voter chose. The audit log only proves *that* a given voter voted, not *for whom*.
- **No vote tampering after the fact** — an Admin cannot revoke a voter's approval once `has_voted = 1`, and a cast vote can never be edited.
- **One-time, single-use voter codes** — voters never have a standing password. Signing in emails a random 6-digit code, hashed with bcrypt before it's stored, valid for 5 minutes, and cleared the instant it's verified (or rejected and reused). There's nothing long-lived to leak, screenshot, or shoulder-surf.
- **Login disabled after voting** — both OTP endpoints reject a voter outright once `has_voted = 1`; a cast ballot can't be revisited, even to just view "already voted" state.
- **Generic auth errors** — invalid email/password returns the same generic message regardless of which field was wrong, so the API never confirms whether an account exists.
- **Password security** — admin/candidate passwords are hashed with bcrypt, never stored or returned in plaintext.
- **Role guards** — every protected route runs through `authMiddleware` (verifies the JWT and reloads the user from the DB) plus a `requireAdmin` / `requireVoter` / `requireCandidate` guard.

## Database schema (SQLite, file: `voting.db` at the repo root)

```
users                     candidates                 candidate_vote_counts      vote_audit_log
─────────────────────     ────────────────────────   ──────────────────────     ──────────────────
id (PK)                   id (PK)                     candidate_id (PK, FK) →    id (PK)
name                       user_id (FK → users.id)     total_votes                voter_id (FK, UNIQUE)
email (UNIQUE)             name                                                   voted_at
password_hash              party_name
role: ADMIN|VOTER|         party_symbol
      CANDIDATE            symbol_photo_url
constituency                candidate_photo_url
is_approved_voter           constituency
has_voted                   manifesto
created_at                  approval_status:
otp_hash                     PENDING|APPROVED|REJECTED
otp_expires_at              created_at
otp_last_sent_at
```

`otp_hash` / `otp_expires_at` / `otp_last_sent_at` back the voter one-time-code login (unused for Admin/Candidate rows). They're additive columns migrated onto `users` at startup, so an existing `voting.db` from before this feature upgrades in place.

On first boot, if the `users` table is empty, `seedRealEastGodavariData()` automatically seeds realistic demo data: 1 admin, 3 candidate accounts (TDP / YSRCP / JSP), 2 extra unlinked candidates, and 7 voters (a mix of approved and not-yet-approved).

## Getting started

```bash
cd vote-backend
npm install

# Development (auto-restarts on save)
npm run dev

# Production
npm run build
npm start
```

The server listens on **http://localhost:5000** by default.

### Environment variables

Copy `.env.example` to `.env` (gitignored) and fill in what you need. Loaded automatically at startup via `process.loadEnvFile()`.

| Variable               | Default                       | Purpose                          |
| ---------------------- | ------------------------------ | --------------------------------- |
| `PORT`                 | `5000`                         | HTTP port                         |
| `JWT_SECRET`           | a built-in dev fallback secret | Signing key for session tokens — **set a real value in production** |
| `EMAILJS_SERVICE_ID`   | —                               | [EmailJS](https://www.emailjs.com) service ID used to send voter OTP emails |
| `EMAILJS_TEMPLATE_ID`  | —                               | EmailJS template ID (expects `to_email`, `to_name`, `from_name`, `from_email`, `message`, `otp_code` params) |
| `EMAILJS_PUBLIC_KEY`   | —                               | EmailJS public key (`user_id`)    |
| `EMAILJS_PRIVATE_KEY`  | —                               | Only needed if the EmailJS account has **Strict Mode** enabled (required for most server-side/non-browser use) |
| `EMAILJS_FROM_NAME`    | `East Godavari Election Commission` | Display name on the OTP email |

Without the `EMAILJS_*` vars set, OTPs are printed to the backend console instead of emailed — handy for local dev without an EmailJS account.

> **Behind a corporate proxy/VPN with TLS inspection?** If OTP requests fail with `fetch failed` / `unable to get local issuer certificate`, that's Node not trusting your network's root CA. `npm run dev`/`npm start` already run with `NODE_OPTIONS=--use-system-ca` (via `cross-env`) to use the OS certificate store instead of Node's bundled one.

## Demo credentials (seeded automatically)

Admin and Candidate accounts still use email + password. **Voters sign in with Voter ID + an emailed one-time code** — there's no password/PIN to list here, and the seeded voters' emails are placeholder addresses (not real inboxes), so you won't actually receive their OTPs. To try the voter flow for real, have an Admin register a new voter (`+ Add voter` in the dashboard) with an email you control.

| Role          | Identifier                        | Secret            | Notes                        |
| ------------- | ---------------------------------- | ------------------- | ------------------------------ |
| Admin         | `admin@elections.ap.gov.in`        | `admin@123`         | District Election Officer      |
| Candidate     | `kondababu.tdp@gmail.com`          | `candidate@123`     | TDP, Kakinada City              |
| Candidate     | `chandrasekhar.ysrcp@gmail.com`    | `candidate@123`     | YSRCP, Kakinada City             |
| Candidate     | `nanaji.jsp@gmail.com`             | `candidate@123`     | JSP, Kakinada Rural              |
| Voter         | `eg-voter-101`                     | (OTP, placeholder email) | Approved, can vote          |
| Voter         | `eg-voter-102`                     | (OTP, placeholder email) | Approved, can vote          |
| Voter         | `eg-voter-105`                     | (OTP, placeholder email) | **Not yet approved** (shows the "pending authorization" flow) |

## API reference

Base URL: `http://localhost:5000/api`

### Authentication

| Method | Path                           | Auth | Body                          | Description |
| ------ | ------------------------------- | ---- | ------------------------------ | ------------ |
| POST   | `/auth/voter/request-otp`      | —    | `{ voterId }`                   | Emails a one-time code to the voter's registered address (5 min TTL, 30s resend cooldown). 403 if already voted. |
| POST   | `/auth/voter/verify-otp`       | —    | `{ voterId, otp }`              | Verifies the code (single-use) → `{ user, token, expiresIn }`. 403 if already voted. |
| POST   | `/auth/login`                   | —    | `{ email, password, role }`     | Admin/Candidate sign-in → `{ user, token, expiresIn }` |
| GET    | `/auth/me`                      | Bearer | —                              | Returns the current authenticated user |

### Candidates

| Method | Path                               | Auth           | Description |
| ------ | ----------------------------------- | -------------- | ------------ |
| GET    | `/candidates`                       | —               | Public list of **approved** candidates (the ballot) |
| POST   | `/candidates/nominate`              | —               | Submit a new self-nomination (starts `PENDING`) |
| GET    | `/candidate/me`                     | Bearer + Candidate | The signed-in candidate's own profile + live vote count |
| PUT    | `/candidate/me`                     | Bearer + Candidate | Update manifesto / party symbol / photos |

### Voting

| Method | Path     | Auth             | Description |
| ------ | -------- | ---------------- | ------------ |
| POST   | `/vote`  | Bearer + Voter    | Cast a ballot (`{ candidateId }`). Rejected if not approved, already voted, or candidate not approved. |

### Admin

| Method | Path                                   | Auth         | Description |
| ------ | ---------------------------------------- | ------------ | ------------ |
| GET    | `/admin/voters`                          | Bearer + Admin | List all voters/candidates with approval + voted status |
| POST   | `/admin/voters`                          | Bearer + Admin | `{ name, voterId, email, constituency? }` — register a new voter directly (auto-authorized to vote, signs in via OTP to the given email) |
| PATCH  | `/admin/voters/:id/approve`              | Bearer + Admin | `{ isApproved }` — grant/revoke voting eligibility (blocked once the voter has voted) |
| GET    | `/admin/candidates`                      | Bearer + Admin | List every nomination (any status) with live vote counts |
| PATCH  | `/admin/candidates/:id/status`           | Bearer + Admin | `{ status: APPROVED \| REJECTED \| PENDING }` |
| GET    | `/admin/stats`                           | Bearer + Admin | `{ totalRegisteredUsers, totalApprovedVoters, totalVotesCast, votingPercentage }` |

## Project structure

```
vote-backend/
├─ src/
│  ├─ index.ts        # Express app, routes, auth & role middleware
│  ├─ db.ts            # better-sqlite3 connection, schema, demo data seed
│  └─ models/index.ts  # Shared TypeScript types (User, Candidate, ElectionStats, ...)
├─ dist/                # Compiled JS output (npm run build)
└─ package.json
```

Pairs with the [vote-frontend](../vote-frontend) React app, which consumes this API at `VITE_API_URL` (defaults to `http://localhost:5000/api`).
