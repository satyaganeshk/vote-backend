-- ==============================================================================
-- DATABASE SCHEMA: SECURE SINGLE-VOTE DEMOCRATIC VOTING SYSTEM (EAST GODAVARI)
-- ==============================================================================
-- STRICT ANONYMOUS BALLOT GUARANTEE:
-- Neither the database schema, nor stored procedures, nor foreign keys allow 
-- correlating which voter voted for which candidate.
-- 1. users: Tracks registration, role, password/pin hash, and has_voted status.
-- 2. candidates: Real political nominees from East Godavari (Kakinada / Rajahmundry).
-- 3. candidate_vote_counts: Aggregated tally per candidate (Admin aggregate view only).
-- 4. vote_audit_log: Proof of participation timestamped per voter (ZERO candidate info).
-- ==============================================================================

-- 1. Users Table
CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('ADMIN', 'VOTER', 'CANDIDATE')),
    constituency TEXT NOT NULL DEFAULT 'East Godavari',
    is_approved_voter INTEGER NOT NULL DEFAULT 0,
    has_voted INTEGER NOT NULL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 2. Candidates Table
CREATE TABLE IF NOT EXISTS candidates (
    id TEXT PRIMARY KEY,
    user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    name TEXT NOT NULL,
    party_name TEXT NOT NULL,
    party_symbol TEXT NOT NULL,
    symbol_photo_url TEXT,
    candidate_photo_url TEXT,
    constituency TEXT NOT NULL,
    manifesto TEXT,
    approval_status TEXT NOT NULL DEFAULT 'PENDING' CHECK(approval_status IN ('PENDING', 'APPROVED', 'REJECTED')),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 3. Anonymous Candidate Vote Count Table
-- Strictly decoupled from voter table: No voter foreign key exists here.
CREATE TABLE IF NOT EXISTS candidate_vote_counts (
    candidate_id TEXT PRIMARY KEY,
    total_votes INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (candidate_id) REFERENCES candidates(id) ON DELETE CASCADE
);

-- 4. Audit Log
-- Proves voter has participated to prevent duplicate voting. 
-- Absolutely NO candidate column or reference exists here.
CREATE TABLE IF NOT EXISTS vote_audit_log (
    id TEXT PRIMARY KEY,
    voter_id TEXT UNIQUE NOT NULL,
    voted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (voter_id) REFERENCES users(id) ON DELETE RESTRICT
);
