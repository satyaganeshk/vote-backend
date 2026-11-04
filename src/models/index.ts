export type Role = 'ADMIN' | 'VOTER' | 'CANDIDATE';

export interface User {
  id: string;
  name: string;
  email: string;
  role: Role;
  isApprovedVoter: boolean;
  hasVoted: boolean;
  createdAt?: string;
}

export type CandidateApprovalStatus = 'PENDING' | 'APPROVED' | 'REJECTED';

export interface Candidate {
  id: string;
  name: string;
  partyName: string;
  partySymbol: string;
  symbolPhotoUrl?: string;
  candidatePhotoUrl?: string;
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
