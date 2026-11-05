import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { db, initDatabase } from './db.js';
import type { Candidate, User, ElectionStats, AuthResponse } from './models/index.js';

try {
  // Loads vote-backend/.env (gitignored) into process.env.
  process.loadEnvFile();
} catch {
  // No .env file present (e.g. production env vars injected another way) — fine.
}

initDatabase();

const app = express();
const PORT = process.env.PORT || 5000;
const JWT_SECRET = process.env.JWT_SECRET || 'east_godavari_election_super_secure_key_2026';
const TOKEN_EXPIRY_SECONDS = 3600; // 1 hour
const OTP_TTL_MS = 5 * 60 * 1000; // 5 minutes
const OTP_RESEND_COOLDOWN_MS = 30 * 1000; // 30 seconds

const EMAILJS_SERVICE_ID = process.env.EMAILJS_SERVICE_ID;
const EMAILJS_TEMPLATE_ID = process.env.EMAILJS_TEMPLATE_ID;
const EMAILJS_PUBLIC_KEY = process.env.EMAILJS_PUBLIC_KEY;
const EMAILJS_PRIVATE_KEY = process.env.EMAILJS_PRIVATE_KEY;
const EMAILJS_FROM_NAME = process.env.EMAILJS_FROM_NAME || 'East Godavari Election Commission';

app.use(cors());
app.use(express.json());

// Sends the voter's one-time login code via EmailJS's REST API.
async function sendOtpEmail(toEmail: string, voterName: string, otp: string): Promise<void> {
  if (!EMAILJS_SERVICE_ID || !EMAILJS_TEMPLATE_ID || !EMAILJS_PUBLIC_KEY) {
    console.log(`[DEV] OTP for ${toEmail} (EmailJS not configured): ${otp}`);
    return;
  }

  const res = await fetch('https://api.emailjs.com/api/v1.0/email/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      service_id: EMAILJS_SERVICE_ID,
      template_id: EMAILJS_TEMPLATE_ID,
      user_id: EMAILJS_PUBLIC_KEY,
      accessToken: EMAILJS_PRIVATE_KEY || undefined,
      template_params: {
        to_email: toEmail,
        from_name: EMAILJS_FROM_NAME,
        from_email: toEmail,
        to_name: voterName,
        message: `Your one-time voting PIN is ${otp}. It expires in 5 minutes and can only be used once.`,
        otp_code: otp,
      },
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`EmailJS send failed (${res.status}): ${body}`);
  }
}

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

function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  if (!domain) return email;
  const visible = local.slice(0, 2);
  return `${visible}${'*'.repeat(Math.max(local.length - visible.length, 1))}@${domain}`;
}

// Voter Login Step 1: request a one-time code emailed to the voter's registered address.
// Replaces the old static-PIN login — nothing long-lived to leak.
app.post('/api/auth/voter/request-otp', async (req: Request, res: Response): Promise<void> => {
  const { voterId } = req.body;

  if (!voterId) {
    res.status(400).json({ error: 'Voter ID is required.' });
    return;
  }

  const userRow = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'VOTER'").get(voterId) as any;
  if (!userRow) {
    res.status(404).json({ error: 'Voter ID not found.' });
    return;
  }

  if (userRow.has_voted) {
    res.status(403).json({ error: 'You have already voted. Login is disabled for this account.' });
    return;
  }

  const now = Date.now();
  if (userRow.otp_last_sent_at && now - new Date(userRow.otp_last_sent_at).getTime() < OTP_RESEND_COOLDOWN_MS) {
    res.status(429).json({ error: 'Please wait a few seconds before requesting another code.' });
    return;
  }

  const otp = crypto.randomInt(100000, 1000000).toString();
  const otpHash = bcrypt.hashSync(otp, 10);
  const expiresAt = new Date(now + OTP_TTL_MS).toISOString();

  db.prepare('UPDATE users SET otp_hash = ?, otp_expires_at = ?, otp_last_sent_at = ? WHERE id = ?')
    .run(otpHash, expiresAt, new Date(now).toISOString(), voterId);

  try {
    await sendOtpEmail(userRow.email, userRow.name, otp);
  } catch (err: any) {
    res.status(502).json({ error: 'Failed to send the OTP email. Please try again shortly.', details: err.message });
    return;
  }

  res.json({ success: true, message: `A one-time code was sent to ${maskEmail(userRow.email)}.` });
});

// Voter Login Step 2: verify the emailed code (single-use, short-lived) and issue a session token.
app.post('/api/auth/voter/verify-otp', (req: Request, res: Response): void => {
  const { voterId, otp } = req.body;

  if (!voterId || !otp) {
    res.status(400).json({ error: 'Voter ID and OTP are required.' });
    return;
  }

  const userRow = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'VOTER'").get(voterId) as any;
  if (!userRow) {
    res.status(401).json({ error: 'Invalid Voter ID or OTP.' });
    return;
  }

  if (userRow.has_voted) {
    res.status(403).json({ error: 'You have already voted. Login is disabled for this account.' });
    return;
  }

  if (!userRow.otp_hash || !userRow.otp_expires_at || Date.now() > new Date(userRow.otp_expires_at).getTime()) {
    res.status(401).json({ error: 'This code has expired. Please request a new one.' });
    return;
  }

  const isValidOtp = bcrypt.compareSync(otp, userRow.otp_hash);
  if (!isValidOtp) {
    res.status(401).json({ error: 'Invalid Voter ID or OTP.' });
    return;
  }

  // Single-use: clear it immediately so the same code can never be replayed.
  db.prepare('UPDATE users SET otp_hash = NULL, otp_expires_at = NULL WHERE id = ?').run(voterId);

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
  const { name, voterId, email, constituency } = req.body;

  if (!name || !voterId || !email) {
    res.status(400).json({ error: 'Name, Voter ID, and email are required.' });
    return;
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    res.status(400).json({ error: 'A valid email is required to deliver the one-time sign-in code.' });
    return;
  }

  const existingId = db.prepare('SELECT id FROM users WHERE id = ?').get(voterId) as any;
  if (existingId) {
    res.status(409).json({ error: 'A voter with this Voter ID already exists.' });
    return;
  }

  const existingEmail = db.prepare('SELECT id FROM users WHERE email = ?').get(email) as any;
  if (existingEmail) {
    res.status(409).json({ error: 'A voter with this email already exists.' });
    return;
  }

  // Login is OTP-only; password_hash is never used for voters but the column is NOT NULL.
  const unusedHash = bcrypt.hashSync(crypto.randomUUID(), 10);

  db.prepare(`
    INSERT INTO users (id, name, email, password_hash, role, constituency, is_approved_voter, has_voted)
    VALUES (?, ?, ?, ?, 'VOTER', ?, 1, 0)
  `).run(voterId, name, email, unusedHash, constituency || 'East Godavari');

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
