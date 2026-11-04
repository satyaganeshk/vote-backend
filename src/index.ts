import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { db, initDatabase } from './db.js';
import type { Candidate, User, ElectionStats, AuthResponse } from './models/index.js';

initDatabase();

const app = express();
const PORT = process.env.PORT || 5000;
const JWT_SECRET = process.env.JWT_SECRET || 'east_godavari_election_super_secure_key_2026';
const TOKEN_EXPIRY_SECONDS = 3600; // 1 hour

app.use(cors());
app.use(express.json());

// Helper to format user response
function formatUser(row: any): User {
  // Find associated candidateId if role is CANDIDATE
  let candidateId: string | undefined = undefined;
  if (row.role === 'CANDIDATE') {
    const cand = db.prepare('SELECT id FROM candidates WHERE user_id = ?').get(row.id) as any;
    if (cand) candidateId = cand.id;
  }

  return {
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role,
    constituency: row.constituency,
    isApprovedVoter: Boolean(row.is_approved_voter),
    hasVoted: Boolean(row.has_voted),
    candidateId,
    createdAt: row.created_at,
  };
}

// Generate JWT token
function generateToken(user: User): string {
  return jwt.sign(
    {
      id: user.id,
      role: user.role,
      name: user.name,
      email: user.email,
    },
    JWT_SECRET,
    { expiresIn: TOKEN_EXPIRY_SECONDS }
  );
}

// Authentication middleware checking Bearer JWT
const authMiddleware = (req: Request, res: Response, next: NextFunction): void => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Session expired or authentication missing.' });
    return;
  }

  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET) as any;
    const userRow = db.prepare('SELECT * FROM users WHERE id = ?').get(decoded.id) as any;
    if (!userRow) {
      res.status(401).json({ error: 'Account no longer exists in election registry.' });
      return;
    }
    (req as any).user = formatUser(userRow);
    next();
  } catch (err: any) {
    res.status(401).json({ error: 'Token expired or invalid.' });
  }
};

// Role authorization guards
const requireAdmin = (req: Request, res: Response, next: NextFunction): void => {
  const user = (req as any).user as User;
  if (!user || user.role !== 'ADMIN') {
    res.status(403).json({ error: 'Access denied: Admin role required.' });
    return;
  }
  next();
};

const requireVoter = (req: Request, res: Response, next: NextFunction): void => {
  const user = (req as any).user as User;
  if (!user || user.role !== 'VOTER') {
    res.status(403).json({ error: 'Access denied: Voter role required.' });
    return;
  }
  next();
};

const requireCandidate = (req: Request, res: Response, next: NextFunction): void => {
  const user = (req as any).user as User;
  if (!user || user.role !== 'CANDIDATE') {
    res.status(403).json({ error: 'Access denied: Candidate role required.' });
    return;
  }
  next();
};

/* ========================================================
   1. AUTHENTICATION ENDPOINTS
======================================================== */

// Voter Login (Voter ID + PIN)
// Generic error message if invalid credentials
app.post('/api/auth/voter-login', (req: Request, res: Response): void => {
  const { voterId, pin } = req.body;

  if (!voterId || !pin) {
    res.status(400).json({ error: 'Invalid voter ID or PIN.' });
    return;
  }

  const userRow = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'VOTER'").get(voterId) as any;
  if (!userRow) {
    res.status(401).json({ error: 'Invalid voter ID or PIN.' });
    return;
  }

  const isValidPin = bcrypt.compareSync(pin, userRow.password_hash);
  if (!isValidPin) {
    res.status(401).json({ error: 'Invalid voter ID or PIN.' });
    return;
  }

  const user = formatUser(userRow);
  const token = generateToken(user);

  const response: AuthResponse = {
    user,
    token,
    expiresIn: TOKEN_EXPIRY_SECONDS,
  };
  res.json(response);
});

// Admin / Candidate Login (Email + Password)
// Generic error message if invalid credentials
app.post('/api/auth/login', (req: Request, res: Response): void => {
  const { email, password, role } = req.body;

  if (!email || !password || !role) {
    res.status(400).json({ error: 'Invalid email or password.' });
    return;
  }

  const userRow = db.prepare('SELECT * FROM users WHERE email = ? AND role = ?').get(email, role) as any;
  if (!userRow) {
    res.status(401).json({ error: 'Invalid email or password.' });
    return;
  }

  const isValidPassword = bcrypt.compareSync(password, userRow.password_hash);
  if (!isValidPassword) {
    res.status(401).json({ error: 'Invalid email or password.' });
    return;
  }

  const user = formatUser(userRow);
  const token = generateToken(user);

  const response: AuthResponse = {
    user,
    token,
    expiresIn: TOKEN_EXPIRY_SECONDS,
  };
  res.json(response);
});

// Get current session from token
app.get('/api/auth/me', authMiddleware, (req: Request, res: Response) => {
  res.json({ user: (req as any).user });
});

/* ========================================================
   2. PUBLIC & VOTER CANDIDATE ROUTES
======================================================== */
app.get('/api/candidates', (_req: Request, res: Response) => {
  const rows = db.prepare(`
    SELECT id, user_id, name, party_name, party_symbol, symbol_photo_url, candidate_photo_url, constituency, manifesto, approval_status
    FROM candidates
    WHERE approval_status = 'APPROVED'
  `).all() as any[];

  const candidates: Candidate[] = rows.map((r) => ({
    id: r.id,
    userId: r.user_id,
    name: r.name,
    partyName: r.party_name,
    partySymbol: r.party_symbol,
    symbolPhotoUrl: r.symbol_photo_url,
    candidatePhotoUrl: r.candidate_photo_url,
    constituency: r.constituency,
    manifesto: r.manifesto,
    approvalStatus: r.approval_status,
  }));
  res.json(candidates);
});

// Candidate Own Profile (Candidate route only)
app.get('/api/candidate/me', authMiddleware, requireCandidate, (req: Request, res: Response): void => {
  const user = (req as any).user as User;
  const cand = db.prepare(`
    SELECT c.*, COALESCE(v.total_votes, 0) as total_votes 
    FROM candidates c
    LEFT JOIN candidate_vote_counts v ON c.id = v.candidate_id
    WHERE c.user_id = ?
  `).get(user.id) as any;

  if (!cand) {
    res.status(404).json({ error: 'Candidate profile not found.' });
    return;
  }

  const candidateProfile: Candidate = {
    id: cand.id,
    userId: cand.user_id,
    name: cand.name,
    partyName: cand.party_name,
    partySymbol: cand.party_symbol,
    symbolPhotoUrl: cand.symbol_photo_url,
    candidatePhotoUrl: cand.candidate_photo_url,
    constituency: cand.constituency,
    manifesto: cand.manifesto,
    approvalStatus: cand.approval_status,
    voteCount: cand.total_votes,
    createdAt: cand.created_at,
  };

  res.json(candidateProfile);
});

// Update own candidate profile (manifesto, photos, etc.)
app.put('/api/candidate/me', authMiddleware, requireCandidate, (req: Request, res: Response): void => {
  const user = (req as any).user as User;
  const { manifesto, symbolPhotoUrl, candidatePhotoUrl, partySymbol } = req.body;

  db.prepare(`
    UPDATE candidates 
    SET manifesto = COALESCE(?, manifesto),
        symbol_photo_url = COALESCE(?, symbol_photo_url),
        candidate_photo_url = COALESCE(?, candidate_photo_url),
        party_symbol = COALESCE(?, party_symbol)
    WHERE user_id = ?
  `).run(manifesto || null, symbolPhotoUrl || null, candidatePhotoUrl || null, partySymbol || null, user.id);

  res.json({ success: true, message: 'Candidate profile updated successfully.' });
});

/* Candidate Nomination */
app.post('/api/candidates/nominate', (req: Request, res: Response): void => {
  const { name, partyName, partySymbol, symbolPhotoUrl, candidatePhotoUrl, constituency, manifesto } = req.body;

  if (!name || !partyName || !partySymbol) {
    res.status(400).json({ error: 'Name, Party Name, and Party Symbol are required.' });
    return;
  }

  const id = `cand-eg-${Date.now()}`;
  db.prepare(`
    INSERT INTO candidates (id, name, party_name, party_symbol, symbol_photo_url, candidate_photo_url, constituency, manifesto, approval_status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'PENDING')
  `).run(
    id,
    name,
    partyName,
    partySymbol,
    symbolPhotoUrl || null,
    candidatePhotoUrl || null,
    constituency || 'East Godavari',
    manifesto || null
  );

  db.prepare(`INSERT INTO candidate_vote_counts (candidate_id, total_votes) VALUES (?, 0)`).run(id);

  res.status(201).json({
    message: 'Candidate nomination submitted. Awaiting Election Commission approval.',
    id,
  });
});

/* ========================================================
   3. VOTING TRANSACTION (STRICT SINGLE VOTE & SECRET BALLOT)
======================================================== */
app.post('/api/vote', authMiddleware, requireVoter, (req: Request, res: Response): void => {
  const voter = (req as any).user as User;
  const { candidateId } = req.body;

  if (!candidateId) {
    res.status(400).json({ error: 'Candidate ID is required to cast ballot.' });
    return;
  }

  // Double check voter record in DB for race conditions
  const freshVoter = db.prepare('SELECT is_approved_voter, has_voted FROM users WHERE id = ?').get(voter.id) as any;
  if (!freshVoter || !freshVoter.is_approved_voter) {
    res.status(403).json({ error: 'You are not authorized by the election administrator to vote.' });
    return;
  }

  if (freshVoter.has_voted) {
    res.status(409).json({ error: 'You have already voted. Under election law, votes cannot be repeated or changed.' });
    return;
  }

  const candidate = db.prepare('SELECT id, approval_status FROM candidates WHERE id = ?').get(candidateId) as any;
  if (!candidate || candidate.approval_status !== 'APPROVED') {
    res.status(404).json({ error: 'Candidate is not approved for election.' });
    return;
  }

  // ATOMIC DATABASE TRANSACTION:
  // Decoupled ballot: users table has_voted = 1, candidate_vote_counts + 1
  const executeVote = db.transaction(() => {
    db.prepare('UPDATE users SET has_voted = 1 WHERE id = ?').run(voter.id);

    const logId = `audit-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
    db.prepare('INSERT INTO vote_audit_log (id, voter_id) VALUES (?, ?)').run(logId, voter.id);

    db.prepare('UPDATE candidate_vote_counts SET total_votes = total_votes + 1 WHERE candidate_id = ?').run(candidateId);
  });

  try {
    executeVote();
    res.json({ success: true, message: 'Your ballot has been officially and permanently submitted.' });
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to record vote securely.', details: err.message });
  }
});

/* ========================================================
   4. ADMIN DASHBOARD & APPROVAL ENDPOINTS
======================================================== */
app.get('/api/admin/voters', authMiddleware, requireAdmin, (_req: Request, res: Response) => {
  const rows = db.prepare("SELECT id, name, email, role, constituency, is_approved_voter, has_voted, created_at FROM users WHERE role != 'ADMIN'").all() as any[];
  const voters: User[] = rows.map((r) => ({
    id: r.id,
    name: r.name,
    email: r.email,
    role: r.role,
    constituency: r.constituency,
    isApprovedVoter: Boolean(r.is_approved_voter),
    hasVoted: Boolean(r.has_voted),
    createdAt: r.created_at,
  }));
  res.json(voters);
});

app.patch('/api/admin/voters/:id/approve', authMiddleware, requireAdmin, (req: Request, res: Response): void => {
  const { id } = req.params;
  const { isApproved } = req.body;

  const target = db.prepare('SELECT id, has_voted FROM users WHERE id = ?').get(id) as any;
  if (!target) {
    res.status(404).json({ error: 'Voter not found in registry.' });
    return;
  }

  if (target.has_voted) {
    res.status(400).json({ error: 'Cannot alter voter authorization after ballot has already been cast.' });
    return;
  }

  db.prepare('UPDATE users SET is_approved_voter = ? WHERE id = ?').run(isApproved ? 1 : 0, id);
  res.json({ success: true, isApproved: Boolean(isApproved) });
});

/* Admin-created voter registration */
app.post('/api/admin/voters', authMiddleware, requireAdmin, (req: Request, res: Response): void => {
  const { name, voterId, pin, constituency } = req.body;

  if (!name || !voterId || !pin) {
    res.status(400).json({ error: 'Name, Voter ID, and PIN are required.' });
    return;
  }

  if (!/^\d{4}$/.test(pin)) {
    res.status(400).json({ error: 'PIN must be exactly 4 digits.' });
    return;
  }

  const existing = db.prepare('SELECT id FROM users WHERE id = ?').get(voterId) as any;
  if (existing) {
    res.status(409).json({ error: 'A voter with this Voter ID already exists.' });
    return;
  }

  const pinHash = bcrypt.hashSync(pin, 10);
  const syntheticEmail = `${voterId}@voter.eastgodavari.gov.in`;

  db.prepare(`
    INSERT INTO users (id, name, email, password_hash, role, constituency, is_approved_voter, has_voted)
    VALUES (?, ?, ?, ?, 'VOTER', ?, 1, 0)
  `).run(voterId, name, syntheticEmail, pinHash, constituency || 'East Godavari');

  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(voterId) as any;
  res.status(201).json({ success: true, message: 'Voter registered and authorized to vote.', user: formatUser(row) });
});

app.get('/api/admin/candidates', authMiddleware, requireAdmin, (_req: Request, res: Response) => {
  const rows = db.prepare(`
    SELECT c.id, c.user_id, c.name, c.party_name, c.party_symbol, c.symbol_photo_url, c.candidate_photo_url, 
           c.constituency, c.manifesto, c.approval_status, COALESCE(v.total_votes, 0) as total_votes
    FROM candidates c
    LEFT JOIN candidate_vote_counts v ON c.id = v.candidate_id
  `).all() as any[];

  const candidates: Candidate[] = rows.map((r) => ({
    id: r.id,
    userId: r.user_id,
    name: r.name,
    partyName: r.party_name,
    partySymbol: r.party_symbol,
    symbolPhotoUrl: r.symbol_photo_url,
    candidatePhotoUrl: r.candidate_photo_url,
    constituency: r.constituency,
    manifesto: r.manifesto,
    approvalStatus: r.approval_status,
    voteCount: r.total_votes,
  }));
  res.json(candidates);
});

app.patch('/api/admin/candidates/:id/status', authMiddleware, requireAdmin, (req: Request, res: Response): void => {
  const { id } = req.params;
  const { status } = req.body;

  if (!['APPROVED', 'REJECTED', 'PENDING'].includes(status)) {
    res.status(400).json({ error: 'Invalid candidate status. Must be APPROVED, REJECTED, or PENDING.' });
    return;
  }

  db.prepare('UPDATE candidates SET approval_status = ? WHERE id = ?').run(status, id);
  res.json({ success: true, candidateId: id, status });
});

app.get('/api/admin/stats', authMiddleware, requireAdmin, (_req: Request, res: Response) => {
  const totalRegisteredUsers = (db.prepare("SELECT COUNT(*) as c FROM users WHERE role = 'VOTER'").get() as any).c;
  const totalApprovedVoters = (db.prepare("SELECT COUNT(*) as c FROM users WHERE role = 'VOTER' AND is_approved_voter = 1").get() as any).c;
  const totalVotesCast = (db.prepare('SELECT COALESCE(SUM(total_votes), 0) as s FROM candidate_vote_counts').get() as any).s;

  const votingPercentage = totalApprovedVoters > 0 ? Math.round((totalVotesCast / totalApprovedVoters) * 100) : 0;

  const stats: ElectionStats = {
    totalRegisteredUsers,
    totalApprovedVoters,
    totalVotesCast,
    votingPercentage,
  };

  res.json(stats);
});

app.listen(PORT, () => {
  console.log(`Voting backend service running on http://localhost:${PORT}`);
});
