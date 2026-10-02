import { readFile, unlink } from "node:fs/promises";
import { fixtureFile, fixtureLockFile } from "./paths.mjs";
import { cleanupFixtures } from "./database-fixtures.mjs";

export default async function globalTeardown() {
  let fixture;
  try {
    fixture = JSON.parse(await readFile(fixtureFile, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw new Error("Could not read the synthetic E2E fixture manifest");
  }

  await cleanupFixtures(fixture);
  await unlink(fixtureFile);
  await unlink(fixtureLockFile);
}