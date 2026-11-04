import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const dbPath = path.resolve(__dirname, '../../voting.db');
export const db = new Database(dbPath);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

export function initDatabase(): void {
  // 1. Initialize Tables
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('ADMIN', 'VOTER', 'CANDIDATE')),
      constituency TEXT NOT NULL DEFAULT 'East Godavari',
      is_approved_voter INTEGER NOT NULL DEFAULT 0,
      has_voted INTEGER NOT NULL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS candidates (
      id TEXT PRIMARY KEY,
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

    CREATE TABLE IF NOT EXISTS candidate_vote_counts (
      candidate_id TEXT PRIMARY KEY,
      total_votes INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (candidate_id) REFERENCES candidates(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS vote_audit_log (
      id TEXT PRIMARY KEY,
      voter_id TEXT UNIQUE NOT NULL,
      voted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (voter_id) REFERENCES users(id) ON DELETE RESTRICT
    );
  `);

  // Ensure real East Godavari seed data is loaded
  seedRealEastGodavariData();
}

function seedRealEastGodavariData() {
  const userCount = (db.prepare('SELECT COUNT(*) as count FROM users').get() as { count: number }).count;
  if (userCount > 0) return;

  const insertUser = db.prepare(`
    INSERT INTO users (id, name, email, role, constituency, is_approved_voter, has_voted)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  // Real South Indian Citizens / Voters from East Godavari District (Kakinada, Rajahmundry, Amalapuram)
  const realVoters = [
    {
      id: 'eg-admin-01',
      name: 'District Election Officer (East Godavari)',
      email: 'collector.kakinada@ap.gov.in',
      role: 'ADMIN',
      constituency: 'East Godavari Headquarters',
      isApproved: 0,
      hasVoted: 0,
    },
    {
      id: 'eg-voter-101',
      name: 'Chundru Venkata Satyanarayana Murthy',
      email: 'cv.satyamurthy@gmail.com',
      role: 'VOTER',
      constituency: 'Kakinada City',
      isApproved: 1,
      hasVoted: 0,
    },
    {
      id: 'eg-voter-102',
      name: 'Alluri Sita Lakshmi Devi',
      email: 'sitalakshmi.alluri@outlook.com',
      role: 'VOTER',
      constituency: 'Rajahmundry City',
      isApproved: 1,
      hasVoted: 0,
    },
    {
      id: 'eg-voter-103',
      name: 'Gollapalli Subba Rao',
      email: 'subbarao.gollapalli@yahoo.com',
      role: 'VOTER',
      constituency: 'Kakinada Rural',
      isApproved: 1,
      hasVoted: 0,
    },
    {
      id: 'eg-voter-104',
      name: 'Kondepudi Bhavani Prasanna',
      email: 'bhavani.kondepudi@gmail.com',
      role: 'VOTER',
      constituency: 'Rajahmundry Rural',
      isApproved: 1,
      hasVoted: 0,
    },
    {
      id: 'eg-voter-105',
      name: 'Maddipati Surya Narayana Raju',
      email: 'surya.maddipati@gmail.com',
      role: 'VOTER',
      constituency: 'Pithapuram',
      isApproved: 0, // Unapproved pending admin verification
      hasVoted: 0,
    },
    {
      id: 'eg-voter-106',
      name: 'Vemulapati Padma Gayatri',
      email: 'gayatri.vemulapati@rediffmail.com',
      role: 'VOTER',
      constituency: 'Kakinada City',
      isApproved: 0, // Unapproved pending admin verification
      hasVoted: 0,
    },
    {
      id: 'eg-voter-107',
      name: 'Nadiminti Veerabhadra Rao',
      email: 'veerabhadra.nadiminti@gmail.com',
      role: 'VOTER',
      constituency: 'Amalapuram',
      isApproved: 1,
      hasVoted: 0,
    },
  ];

  for (const u of realVoters) {
    insertUser.run(u.id, u.name, u.email, u.role, u.constituency, u.isApproved, u.hasVoted);
  }

  const insertCandidate = db.prepare(`
    INSERT INTO candidates (id, name, party_name, party_symbol, symbol_photo_url, candidate_photo_url, constituency, manifesto, approval_status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertVoteCount = db.prepare(`
    INSERT INTO candidate_vote_counts (candidate_id, total_votes)
    VALUES (?, ?)
  `);

  // Real South Indian Participants & Candidates representing East Godavari District
  const realCandidates = [
    {
      id: 'cand-eg-01',
      name: 'Vanamadi Venkateswara Rao (Konda Babu)',
      party_name: 'Telugu Desam Party (TDP)',
      party_symbol: '🚲 Bicycle',
      symbol_url: 'https://upload.wikimedia.org/wikipedia/commons/thumb/d/de/Telugu_Desam_Party_flag.svg/240px-Telugu_Desam_Party_flag.svg.png',
      cand_url: 'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=300&auto=format&fit=crop&q=80',
      constituency: 'Kakinada City',
      manifesto: 'Expansion of Kakinada deep-water port, modern cold-storage facilities for coastal aqua farmers, and smart city infrastructure overhaul.',
      status: 'APPROVED',
      votes: 1420,
    },
    {
      id: 'cand-eg-02',
      name: 'Dwarampudi Chandrasekhar Reddy',
      party_name: 'Yuvajana Sramika Rythu Congress Party (YSRCP)',
      party_symbol: '🪭 Fan',
      symbol_url: 'https://upload.wikimedia.org/wikipedia/commons/thumb/e/ef/YSR_Congress_Party_flag.svg/240px-YSR_Congress_Party_flag.svg.png',
      cand_url: 'https://images.unsplash.com/photo-1500648767791-00dcc994a43e?w=300&auto=format&fit=crop&q=80',
      constituency: 'Kakinada City',
      manifesto: 'Welfare disbursements for port laborers, enhancement of government hospitals in East Godavari, and subsidized power for handloom weavers.',
      status: 'APPROVED',
      votes: 1185,
    },
    {
      id: 'cand-eg-03',
      name: 'Pantham Nanaji',
      party_name: 'Jana Sena Party (JSP)',
      party_symbol: '🥛 Glass Tumbler',
      symbol_url: 'https://upload.wikimedia.org/wikipedia/commons/thumb/1/14/Jana_Sena_Party_Flag.svg/240px-Jana_Sena_Party_Flag.svg.png',
      cand_url: 'https://images.unsplash.com/photo-1472099645785-5658abf4ff4e?w=300&auto=format&fit=crop&q=80',
      constituency: 'Kakinada Rural',
      manifesto: 'Youth tech hubs along NH-16, zero corruption in agricultural subsidies, and Godavari delta flood protection embankments.',
      status: 'APPROVED',
      votes: 1540,
    },
    {
      id: 'cand-eg-04',
      name: 'Adireddy Srinivas (Vasu)',
      party_name: 'Telugu Desam Party (TDP)',
      party_symbol: '🚲 Bicycle',
      symbol_url: 'https://upload.wikimedia.org/wikipedia/commons/thumb/d/de/Telugu_Desam_Party_flag.svg/240px-Telugu_Desam_Party_flag.svg.png',
      cand_url: 'https://images.unsplash.com/photo-1519085360753-af0119f7cbe7?w=300&auto=format&fit=crop&q=80',
      constituency: 'Rajahmundry City',
      manifesto: 'Heritage corridor development across River Godavari ghats, IT incubation centers in Rajahmundry, and underground drainage modernization.',
      status: 'APPROVED',
      votes: 1390,
    },
    {
      id: 'cand-eg-05',
      name: 'Margani Bharat Ram',
      party_name: 'Yuvajana Sramika Rythu Congress Party (YSRCP)',
      party_symbol: '🪭 Fan',
      symbol_url: 'https://upload.wikimedia.org/wikipedia/commons/thumb/e/ef/YSR_Congress_Party_flag.svg/240px-YSR_Congress_Party_flag.svg.png',
      cand_url: 'https://images.unsplash.com/photo-1506794778202-cad84cf45f1d?w=300&auto=format&fit=crop&q=80',
      constituency: 'Rajahmundry City',
      manifesto: 'Airport expansion in Madhurapudi, arts & culture university encouragement, and financial security schemes for Godavari transport workers.',
      status: 'PENDING', // Pending nomination awaiting Admin approval
      votes: 0,
    },
  ];

  for (const c of realCandidates) {
    insertCandidate.run(
      c.id,
      c.name,
      c.party_name,
      c.party_symbol,
      c.symbol_url,
      c.cand_url,
      c.constituency,
      c.manifesto,
      c.status
    );
    insertVoteCount.run(c.id, c.votes);
  }
}
