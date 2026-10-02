import { join } from "node:path";
import { tmpdir } from "node:os";

export const fixtureFile = join(tmpdir(), "appzex-e2e-fixtures.json");
export const fixtureLockFile = `${fixtureFile}.lock`;