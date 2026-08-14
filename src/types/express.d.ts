import { MembershipRole } from '../models/Membership';

declare global {
  namespace Express {
    interface Request {
      auth?: {
        userId: string;
        tenantId?: string;
        role?: MembershipRole;
      };
    }
  }
}

export {};
