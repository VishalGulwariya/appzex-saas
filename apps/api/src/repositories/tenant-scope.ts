import { GlobalRole } from "@prisma/client";
import type { RequestAuthContext } from "../types/express.js";

export class AuthorizationError extends Error {
  constructor(message = "An authenticated tenant context is required") {
    super(message);
    this.name = "AuthorizationError";
  }
}

export type TenantScope =
  | { agencyId: string; userId: string; kind: "agency"; assignedOnly: boolean; managedOnly: boolean }
  | { agencyId: string; userId: string; kind: "support"; assignedOnly: false; managedOnly: false }
  | { agencyId: string; userId: string; kind: "client"; clientId: string; assignedOnly: false; managedOnly: false };

export function clientTenantScope(context: RequestAuthContext): { agencyId: string; clientId: string } {
  const scope = tenantScope(context);
  if (scope.kind !== "client") throw new AuthorizationError("Client workspace context required");
  return { agencyId: scope.agencyId, clientId: scope.clientId };
}

export function tenantScope(context: RequestAuthContext): TenantScope {
  if (context.globalRole === GlobalRole.SUPER_ADMIN) {
    if (context.portal !== "super-admin" || !context.supportSessionId || !context.supportAgencyId) throw new AuthorizationError("An explicit support session is required for agency data");
    return { agencyId: context.supportAgencyId, userId: context.userId, kind: "support", assignedOnly: false, managedOnly: false };
  }
  if (context.portal === "agency" && context.agencyId && context.agencyRole) {
    return {
      agencyId: context.agencyId,
      userId: context.userId,
      kind: "agency",
      assignedOnly: context.agencyRole === "MEMBER",
      managedOnly: context.agencyRole === "PROJECT_MANAGER"
    };
  }
  if (context.portal === "client" && context.agencyId && context.clientId) {
    return { agencyId: context.agencyId, userId: context.userId, kind: "client", clientId: context.clientId, assignedOnly: false, managedOnly: false };
  }
  throw new AuthorizationError();
}

