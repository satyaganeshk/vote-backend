# Vote Backend

Secure, role-based REST API that powers a single-vote democratic election system, built as a demo for the **District Election Commission — East Godavari (Andhra Pradesh)**.

It enforces the hard rules of a real election: every voter must be explicitly authorized before they can vote, every voter gets exactly **one** vote, votes can never be changed or retracted, and individual ballots are never traceable back to a voter (secret ballot) — only aggregate tallies are exposed.

## Tech stack

| Concern              | Library                                   |
| -------------------- | ------------------------------------------ |
| HTTP server          | [Express 4](https://expressjs.com/) (TypeScript, ESM) |
| Database             | [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) — embedded SQLite, WAL journal mode |
| Auth                 | [jsonwebtoken](https://github.com/auth0/node-jsonwebtoken) (1-hour bearer tokens) |
| Password / PIN hashing | [bcryptjs](https://github.com/dcodeIO/bcrypt.js) |
| Cross-origin requests | [cors](https://github.com/expressjs/cors) |
| Dev runtime          | [tsx](https://github.com/privatenumber/tsx) (watch mode) |

## Domain model — three roles, three different logins

| Role          | How they sign in              | What they can do |
| ------------- | ------------------------------ | ----------------- |
| **VOTER**     | Voter ID + 4-digit PIN         | View the approved candidate list and cast **exactly one** vote, once authorized by an Admin. |
| **CANDIDATE** | Email + password               | View their own nomination profile and live vote count; edit manifesto, party symbol, and photos. New candidates can self-nominate and start out `PENDING`. |
| **ADMIN**     | Email + password                | Approve/revoke voter eligibility, approve/reject candidate nominations, nominate candidates on anyone's behalf, and view live, anonymized turnout + results. |

### Why it's "secure by design"

- **Single-vote invariant** — casting a vote is one atomic SQLite transaction: it flips `users.has_voted`, writes a `vote_audit_log` row, and increments `candidate_vote_counts` together. The server re-checks `has_voted`/`is_approved_voter` from the database on every request (not just the JWT) to close race conditions.
- **Secret ballot** — there is no column anywhere that links a `vote_audit_log` row to *which candidate* a voter chose. The audit log only proves *that* a given voter voted, not *for whom*.
- **No vote tampering after the fact** — an Admin cannot revoke a voter's approval once `has_voted = 1`, and a cast vote can never be edited.
- **Generic auth errors** — invalid Voter ID/PIN and invalid email/password both return the same generic message, so the API never confirms whether an account exists.
- **Password security** — PINs and passwords are hashed with bcrypt, never stored or returned in plaintext.
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
                             PENDING|APPROVED|REJECTED
                            created_at
```

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

| Variable      | Default                                   | Purpose                          |
| ------------- | ------------------------------------------ | --------------------------------- |
| `PORT`        | `5000`                                     | HTTP port                         |
| `JWT_SECRET`  | a built-in dev fallback secret             | Signing key for session tokens — **set a real value in production** |

## Demo credentials (seeded automatically)

| Role          | Identifier                        | Secret            | Notes                        |
| ------------- | ---------------------------------- | ------------------- | ------------------------------ |
| Admin         | `admin@elections.ap.gov.in`        | `admin@123`         | District Election Officer      |
| Candidate     | `kondababu.tdp@gmail.com`          | `candidate@123`     | TDP, Kakinada City              |
| Candidate     | `chandrasekhar.ysrcp@gmail.com`    | `candidate@123`     | YSRCP, Kakinada City             |
| Candidate     | `nanaji.jsp@gmail.com`             | `candidate@123`     | JSP, Kakinada Rural              |
| Voter         | `eg-voter-101`                     | PIN `1234`           | Approved, can vote               |
| Voter         | `eg-voter-102`                     | PIN `1234`           | Approved, can vote               |
| Voter         | `eg-voter-105`                     | PIN `1234`           | **Not yet approved** (shows the "pending authorization" flow) |

## API reference

Base URL: `http://localhost:5000/api`

### Authentication

| Method | Path                    | Auth | Body                                   | Description |
| ------ | ----------------------- | ---- | --------------------------------------- | ------------ |
| POST   | `/auth/voter-login`     | —    | `{ voterId, pin }`                       | Voter sign-in → `{ user, token, expiresIn }` |
| POST   | `/auth/login`           | —    | `{ email, password, role }`              | Admin/Candidate sign-in → `{ user, token, expiresIn }` |
| GET    | `/auth/me`               | Bearer | —                                       | Returns the current authenticated user |

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
