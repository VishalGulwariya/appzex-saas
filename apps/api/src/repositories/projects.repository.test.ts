import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgencyRole, GlobalRole } from "@prisma/client";
import type { RequestAuthContext } from "../types/express.js";

const { projectFindFirst } = vi.hoisted(() => ({ projectFindFirst: vi.fn() }));
vi.mock("../lib/prisma.js", () => ({ prisma: { project: { findFirst: projectFindFirst } } }));

import { findProjectForContext } from "./projects.repository.js";

const agencyContext = {
  userId: "member-a",
  globalRole: GlobalRole.USER,
  portal: "agency",
  sessionId: "session-a",
  agencyId: "agency-a",
  agencyRole: AgencyRole.ADMIN
} satisfies RequestAuthContext;

describe("findProjectForContext tenant scope", () => {
  beforeEach(() => {
    projectFindFirst.mockReset();
    projectFindFirst.mockResolvedValue(null);
  });

  it("constrains project lookup to the authenticated agency and selected project", async () => {
    await expect(findProjectForContext(agencyContext, "project-from-agency-b")).resolves.toBeNull();
    expect(projectFindFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ agencyId: "agency-a", id: "project-from-agency-b" })
    }));
  });
});
