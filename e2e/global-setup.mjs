import { open, readFile, unlink, writeFile } from "node:fs/promises";
import { fixtureFile, fixtureLockFile } from "./paths.mjs";
import { assertLocalTestDatabase, createFixtures, cleanupFixtures } from "./database-fixtures.mjs";

async function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

async function recoverInterruptedRun() {
  try {
    const staleFixture = JSON.parse(await readFile(fixtureFile, "utf8"));
    await cleanupFixtures(staleFixture);
    await unlink(fixtureFile);
  } catch (error) {
    if (error?.code !== "ENOENT") throw new Error("Could not safely recover previous synthetic E2E fixtures");
  }
}

export default async function globalSetup() {
  assertLocalTestDatabase();
  let lock;
  try {
    lock = await open(fixtureLockFile, "wx");
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    let owner;
    try { owner = JSON.parse(await readFile(fixtureLockFile, "utf8")); } catch { throw new Error("An E2E fixture lock exists and cannot be verified"); }
    if (await processIsAlive(owner.pid)) throw new Error("Another AppZex E2E run is active; fixture writes were skipped");
    await recoverInterruptedRun();
    await unlink(fixtureLockFile);
    lock = await open(fixtureLockFile, "wx");
  }

  let fixture;
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    await lock.close();
    fixture = await createFixtures();
    await writeFile(fixtureFile, JSON.stringify(fixture), { encoding: "utf8", mode: 0o600, flag: "wx" });
  } catch (error) {
    if (fixture) await cleanupFixtures(fixture);
    await unlink(fixtureFile).catch(() => undefined);
    await unlink(fixtureLockFile).catch(() => undefined);
    throw error;
  }
}