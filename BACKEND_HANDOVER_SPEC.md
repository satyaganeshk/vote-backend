# Backend Specification & Database Schema Handover

## Overview
This document is prepared from the `vote-frontend` specifications to build the matching backend service in `vote-backend`. It defines the SQL schema, API endpoints, role-based constraints, and security policies.

---

## 1. Database Schema (PostgreSQL / MySQL Compatible)

```sql
-- 1. Roles Enum
CREATE TYPE user_role AS ENUM ('ADMIN', 'VOTER', 'CANDIDATE');
CREATE TYPE candidate_status AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- 2. Users Table
CREATE TABLE users (
    id VARCHAR(64) PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    role user_role NOT NULL DEFAULT 'VOTER',
    is_approved_voter BOOLEAN NOT NULL DEFAULT FALSE,
    has_voted BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 3. Candidates Table
CREATE TABLE candidates (
    id VARCHAR(64) PRIMARY KEY,
    user_id VARCHAR(64) REFERENCES users(id) ON DELETE SET NULL,
    name VARCHAR(255) NOT NULL,
    party_name VARCHAR(255) NOT NULL,
    party_symbol VARCHAR(32) NOT NULL, -- Text / Emoji (e.g., 🌱, ⚡)
    symbol_photo_url TEXT,
    candidate_photo_url TEXT,
    manifesto TEXT,
    approval_status candidate_status NOT NULL DEFAULT 'PENDING',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 4. Candidate Vote Aggregates (Decoupled Anonymous Ballot Box)
-- To ensure the ballot is secret and strictly decoupled from the voter's identity:
CREATE TABLE candidate_vote_counts (
    candidate_id VARCHAR(64) PRIMARY KEY REFERENCES candidates(id) ON DELETE CASCADE,
    total_votes INT NOT NULL DEFAULT 0
);

-- 5. Audit Log (Voter Participation Verification)
-- Records that a voter participated without recording WHICH candidate they selected.
CREATE TABLE vote_audit_log (
    id VARCHAR(64) PRIMARY KEY,
    voter_id VARCHAR(64) UNIQUE REFERENCES users(id) ON DELETE RESTRICT,
    voted_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
```

---

## 2. Security & Anti-Fraud Guarantees

1. **Anonymous Ballots**:
   - `vote_audit_log` records `voter_id` to enforce that a voter participated. It has **no** candidate foreign key.
   - `candidate_vote_counts` stores only the total aggregate count per candidate.
   - Even database administrators and election officials **cannot correlate a voter to their chosen candidate**.
2. **Transaction Isolation for Ballot Casting**:
   When a vote is cast:
   ```sql
   BEGIN TRANSACTION;
   -- 1. Check eligibility:
   -- SELECT role, is_approved_voter, has_voted FROM users WHERE id = :voter_id FOR UPDATE;
   -- Ensure role != 'ADMIN', is_approved_voter = TRUE, has_voted = FALSE.
   
   -- 2. Mark user has voted:
   UPDATE users SET has_voted = TRUE WHERE id = :voter_id;
   
   -- 3. Insert audit proof:
   INSERT INTO vote_audit_log (id, voter_id, voted_at) VALUES (:log_id, :voter_id, NOW());
   
   -- 4. Increment candidate count:
   UPDATE candidate_vote_counts SET total_votes = total_votes + 1 WHERE candidate_id = :candidate_id;
   
   COMMIT;
   ```
3. **No Retraction Policy**:
   - Once `has_voted` is set to `TRUE`, no endpoint allows unvoting, undoing, or editing a vote.

---

## 3. Required REST API Endpoints

### Authentication & Profile
- `POST /api/auth/login` - Login and issue JWT with `{ id, role, isApprovedVoter, hasVoted }`
- `GET /api/auth/me` - Current session details

### Voter Endpoints (Role: `VOTER`)
- `GET /api/candidates` - Retrieve all `APPROVED` candidates (public/voter view, no vote counts revealed to voters)
- `POST /api/ballot/vote`
  - Body: `{ candidateId: string }`
  - Strict validation: user must be `isApprovedVoter === true` and `hasVoted === false`.

### Admin Endpoints (Role: `ADMIN`)
- `GET /api/admin/voters` - List all registered voters with `isApprovedVoter` and `hasVoted` status
- `PATCH /api/admin/voters/:id/approve`
  - Body: `{ isApproved: boolean }`
  - Condition: Cannot change approval if `hasVoted === true`
- `GET /api/admin/candidates` - List all candidates (PENDING, APPROVED, REJECTED)
- `PATCH /api/admin/candidates/:id/status`
  - Body: `{ status: 'APPROVED' | 'REJECTED' }`
- `GET /api/admin/stats` - Election turnout stats and aggregate candidate vote tallies

### Candidate Nomination
- `POST /api/candidates/nominate`
  - Body: `{ name, partyName, partySymbol, symbolPhotoUrl, candidatePhotoUrl, manifesto }`
  - Status automatically set to `PENDING`
