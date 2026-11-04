import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const dbPath = path.resolve(__dirname, '../../voting.db');
export const db = new Database(dbPath);

// Enable WAL mode & foreign keys for high reliability and concurrency
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

export function initDatabase(): void {
  db.exec(`
    -- 1. Users Table
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('ADMIN', 'VOTER', 'CANDIDATE')),
      is_approved_voter INTEGER NOT NULL DEFAULT 0,
      has_voted INTEGER NOT NULL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- 2. Candidates Table
    CREATE TABLE IF NOT EXISTS candidates (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      party_name TEXT NOT NULL,
      party_symbol TEXT NOT NULL,
      symbol_photo_url TEXT,
      candidate_photo_url TEXT,
      manifesto TEXT,
      approval_status TEXT NOT NULL DEFAULT 'PENDING' CHECK(approval_status IN ('PENDING', 'APPROVED', 'REJECTED')),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- 3. Anonymous Candidate Vote Count Table
    -- Aggregated counter strictly decoupled from voter identity to preserve ballot secrecy
    CREATE TABLE IF NOT EXISTS candidate_vote_counts (
      candidate_id TEXT PRIMARY KEY,
      total_votes INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (candidate_id) REFERENCES candidates(id) ON DELETE CASCADE
    );

    -- 4. Audit Log
    -- Proves voter participation; deliberately DOES NOT store candidate choice
    CREATE TABLE IF NOT EXISTS vote_audit_log (
      id TEXT PRIMARY KEY,
      voter_id TEXT UNIQUE NOT NULL,
      voted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (voter_id) REFERENCES users(id) ON DELETE RESTRICT
    );
  `);

  // Seed default admin and initial records if empty
  const userCount = (db.prepare('SELECT COUNT(*) as count FROM users').get() as { count: number }).count;
  if (userCount === 0) {
    seedInitialData();
  }
}

function seedInitialData() {
  const insertUser = db.prepare(`
    INSERT INTO users (id, name, email, role, is_approved_voter, has_voted)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  const initialUsers = [
    {
      id: 'u-admin-1',
      name: 'Eleanor Vance (Election Commissioner)',
      email: 'admin@elections.gov',
      role: 'ADMIN',
      isApproved: 0,
      hasVoted: 0,
    },
    {
      id: 'u-voter-1',
      name: 'Satya K.',
      email: 'satya@example.com',
      role: 'VOTER',
      isApproved: 1,
      hasVoted: 0,
    },
    {
      id: 'u-voter-2',
      name: 'Priya Sharma',
      email: 'priya@example.com',
      role: 'VOTER',
      isApproved: 1,
      hasVoted: 0,
    },
    {
      id: 'u-voter-3',
      name: 'Marcus Brody',
      email: 'marcus@example.com',
      role: 'VOTER',
      isApproved: 0,
      hasVoted: 0,
    },
  ];

  for (const u of initialUsers) {
    insertUser.run(u.id, u.name, u.email, u.role, u.isApproved, u.hasVoted);
  }

  const insertCandidate = db.prepare(`
    INSERT INTO candidates (id, name, party_name, party_symbol, symbol_photo_url, candidate_photo_url, manifesto, approval_status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertVoteCount = db.prepare(`
    INSERT INTO candidate_vote_counts (candidate_id, total_votes)
    VALUES (?, ?)
  `);

  const initialCandidates = [
    {
      id: 'cand-1',
      name: 'Dr. Jane Cooper',
      party_name: 'Green Future Alliance',
      party_symbol: '🌱',
      symbol_url: 'https://images.unsplash.com/photo-1542601906990-b4d3fb778b09?w=160',
      cand_url: 'https://images.unsplash.com/photo-1573496359142-b8d87734a5a2?w=200',
      manifesto: 'Clean tech transition, public health modernization, and fair citizen dividend.',
      status: 'APPROVED',
      votes: 12,
    },
    {
      id: 'cand-2',
      name: 'Alexandria Sterling',
      party_name: 'Innovation & Tech Coalition',
      party_symbol: '⚡',
      symbol_url: 'https://images.unsplash.com/photo-1518770660439-4636190af475?w=160',
      cand_url: 'https://images.unsplash.com/photo-1560250097-0b93528c311a?w=200',
      manifesto: 'High-speed nationwide infrastructure, AI education in public schools, and tax credits for startups.',
      status: 'APPROVED',
      votes: 19,
    },
    {
      id: 'cand-3',
      name: 'Robert Hayes',
      party_name: 'Heritage & Unity Party',
      party_symbol: '🏛️',
      symbol_url: 'https://images.unsplash.com/photo-1569437061241-a848be43cc82?w=160',
      cand_url: 'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=200',
      manifesto: 'Strengthening community governance, family security support, and cultural preservation funds.',
      status: 'PENDING',
      votes: 0,
    },
  ];

  for (const c of initialCandidates) {
    insertCandidate.run(
      c.id,
      c.name,
      c.party_name,
      c.party_symbol,
      c.symbol_url,
      c.cand_url,
      c.manifesto,
      c.status
    );
    insertVoteCount.run(c.id, c.votes);
  }
}
