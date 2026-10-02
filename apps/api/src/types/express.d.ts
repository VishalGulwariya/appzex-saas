import type { AgencyRole, GlobalRole } from "@prisma/client";

export type RequestAuthContext = {
  userId: string;
  globalRole: GlobalRole;
  portal: "super-admin" | "agency" | "client" | "selection";
  sessionId: string;
  agencyId?: string;
  agencyRole?: AgencyRole;
  agencyName?: string;
  clientId?: string;
  clientMembershipId?: string;
  clientName?: string;
  supportSessionId?: string;
  supportAgencyId?: string;
  supportAgencyName?: string;
};

declare global {
  namespace Express {
    interface Request {
      id?: string;
      auth?: RequestAuthContext;
    }
  }
}

export {};

