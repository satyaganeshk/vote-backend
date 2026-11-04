import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import { db, initDatabase } from './db.js';
import type { Candidate, User, ElectionStats } from './models/index.js';

initDatabase();

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

// Simulated RBAC session middleware (reads X-User-Id header)
const authMiddleware = (req: Request, res: Response, next: NextFunction): void => {
  const userId = req.headers['x-user-id'] as string;
  if (!userId) {
    res.status(401).json({ error: 'Authentication required. Provide X-User-Id header.' });
    return;
  }
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId) as any;
  if (!user) {
    res.status(403).json({ error: 'User does not exist in election registry.' });
    return;
  }
  (req as any).user = {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    constituency: user.constituency,
    isApprovedVoter: Boolean(user.is_approved_voter),
    hasVoted: Boolean(user.has_voted),
  };
  next();
};

const requireAdmin = (req: Request, res: Response, next: NextFunction): void => {
  const user = (req as any).user as User;
  if (!user || user.role !== 'ADMIN') {
    res.status(403).json({ error: 'Access denied: Election Commission Admin privileges required.' });
    return;
  }
  next();
};

/* ========================================================
   1. USER & SESSION ROUTES (NO MOCK DATA)
======================================================== */
app.get('/api/users', (_req: Request, res: Response) => {
  const rows = db.prepare('SELECT id, name, email, role, constituency, is_approved_voter, has_voted FROM users').all() as any[];
  const users: User[] = rows.map((r) => ({
    id: r.id,
    name: r.name,
    email: r.email,
    role: r.role,
    constituency: r.constituency,
    isApprovedVoter: Boolean(r.is_approved_voter),
    hasVoted: Boolean(r.has_voted),
  }));
  res.json(users);
});

app.get('/api/me', authMiddleware, (req: Request, res: Response) => {
  res.json((req as any).user);
});

/* ========================================================
   2. CANDIDATE ROUTES (PUBLIC / VOTER)
======================================================== */
app.get('/api/candidates', (_req: Request, res: Response) => {
  const rows = db.prepare(`
    SELECT id, name, party_name, party_symbol, symbol_photo_url, candidate_photo_url, constituency, manifesto, approval_status
    FROM candidates
    WHERE approval_status = 'APPROVED'
  `).all() as any[];

  const candidates: Candidate[] = rows.map((r) => ({
    id: r.id,
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

/* Candidate Nomination (East Godavari) */
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
app.post('/api/vote', authMiddleware, (req: Request, res: Response): void => {
  const voter = (req as any).user as User;
  const { candidateId } = req.body;

  if (!candidateId) {
    res.status(400).json({ error: 'Candidate ID is required to cast ballot.' });
    return;
  }

  // Strict Policy Check 1: Admins cannot vote
  if (voter.role === 'ADMIN') {
    res.status(403).json({ error: 'Election Commission Administrators are strictly neutral and forbidden to vote.' });
    return;
  }

  // Strict Policy Check 2: Must be approved voter
  if (!voter.isApprovedVoter) {
    res.status(403).json({ error: 'You are not approved by the election administrator to cast a vote.' });
    return;
  }

  // Strict Policy Check 3: Strictly one vote only (no multiple votes, no withdrawal)
  if (voter.hasVoted) {
    res.status(409).json({ error: 'Vote already recorded. Strict policy: Multiple or modified votes are prohibited.' });
    return;
  }

  // Strict Policy Check 4: Candidate must exist and be APPROVED
  const candidate = db.prepare('SELECT id, approval_status FROM candidates WHERE id = ?').get(candidateId) as any;
  if (!candidate || candidate.approval_status !== 'APPROVED') {
    res.status(404).json({ error: 'Target candidate does not exist or is not approved for election.' });
    return;
  }

  // ATOMIC DATABASE TRANSACTION:
  // 1. Mark voter has_voted = 1
  // 2. Insert audit proof in vote_audit_log (NO candidate foreign key / trace)
  // 3. Increment candidate aggregate tally in candidate_vote_counts
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
/* List all voters */
app.get('/api/admin/voters', authMiddleware, requireAdmin, (_req: Request, res: Response) => {
  const rows = db.prepare('SELECT id, name, email, role, constituency, is_approved_voter, has_voted, created_at FROM users WHERE role != "ADMIN"').all() as any[];
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

/* Authorize or restrict voter */
app.patch('/api/admin/voters/:id/approve', authMiddleware, requireAdmin, (req: Request, res: Response): void => {
  const { id } = req.params;
  const { isApproved } = req.body;

  const target = db.prepare('SELECT id, has_voted FROM users WHERE id = ?').get(id) as any;
  if (!target) {
    res.status(404).json({ error: 'Voter not found in registry.' });
    return;
  }

  // Strict Policy: Admin cannot alter authorization after a vote has already been cast
  if (target.has_voted) {
    res.status(400).json({ error: 'Cannot alter voter authorization after ballot has already been cast.' });
    return;
  }

  db.prepare('UPDATE users SET is_approved_voter = ? WHERE id = ?').run(isApproved ? 1 : 0, id);
  res.json({ success: true, isApproved: Boolean(isApproved) });
});

/* List all candidates (with vote counts for Admin only) */
app.get('/api/admin/candidates', authMiddleware, requireAdmin, (_req: Request, res: Response) => {
  const rows = db.prepare(`
    SELECT c.id, c.name, c.party_name, c.party_symbol, c.symbol_photo_url, c.candidate_photo_url, 
           c.constituency, c.manifesto, c.approval_status, COALESCE(v.total_votes, 0) as total_votes
    FROM candidates c
    LEFT JOIN candidate_vote_counts v ON c.id = v.candidate_id
  `).all() as any[];

  const candidates: Candidate[] = rows.map((r) => ({
    id: r.id,
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

/* Approve or Reject candidate */
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

/* Election aggregate stats */
app.get('/api/admin/stats', authMiddleware, requireAdmin, (_req: Request, res: Response) => {
  const totalRegisteredUsers = (db.prepare('SELECT COUNT(*) as c FROM users WHERE role != "ADMIN"').get() as any).c;
  const totalApprovedVoters = (db.prepare('SELECT COUNT(*) as c FROM users WHERE role != "ADMIN" AND is_approved_voter = 1').get() as any).c;
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
