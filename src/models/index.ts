export type Role = 'ADMIN' | 'VOTER' | 'CANDIDATE';

export interface User {
  id: string;
  name: string;
  email: string;
  role: Role;
  constituency?: string;
  isApprovedVoter: boolean;
  hasVoted: boolean;
  candidateId?: string; // Link to candidate profile if role is CANDIDATE
  createdAt?: string;
}

export type CandidateApprovalStatus = 'PENDING' | 'APPROVED' | 'REJECTED';

export interface Candidate {
  id: string;
  userId?: string;
  name: string;
  partyName: string;
  partySymbol: string;
  symbolPhotoUrl?: string;
  candidatePhotoUrl?: string;
  constituency?: string;
  manifesto?: string;
  approvalStatus: CandidateApprovalStatus;
  voteCount?: number;
  createdAt?: string;
}

export interface ElectionStats {
  totalRegisteredUsers: number;
  totalApprovedVoters: number;
  totalVotesCast: number;
  votingPercentage: number;
}

export interface AuthResponse {
  user: User;
  token: string;
  expiresIn: number; // in seconds
}

export interface VoterLoginPayload {
  voterId: string;
  pin: string;
}

export interface CredentialLoginPayload {
  email: string;
  password: string;
  role: 'ADMIN' | 'CANDIDATE';
}
