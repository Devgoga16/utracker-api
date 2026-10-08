import { MembershipRole } from '../models/Membership';

declare global {
  namespace Express {
    interface Request {
      auth?: {
        userId: string;
        tenantId?: string;
        role?: MembershipRole;
        /**
         * Presente cuando quien entró es soporte, no un miembro del negocio.
         * Lo usan los logs para distinguir "el dueño borró esto" de
         * "soporte borró esto".
         */
        support?: {
          accessId: string;
          canWrite: boolean;
        };
      };
    }
  }
}

export {};
