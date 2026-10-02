import { app } from "./app.js";
import { env } from "./config/env.js";
import { prisma } from "./lib/prisma.js";

const server = app.listen(env.API_PORT, () => {
  console.info(`AppZex API listening on port ${env.API_PORT}`);
});

let shutdownStarted = false;

function shutdown(signal: NodeJS.Signals): void {
  if (shutdownStarted) return;
  shutdownStarted = true;
  const forcedClose = setTimeout(() => server.closeAllConnections(), 10000);
  forcedClose.unref();

  server.close((error) => {
    clearTimeout(forcedClose);
    void prisma.$disconnect().then(() => {
      if (error) {
        process.exitCode = 1;
        console.error(`API shutdown completed with a server close error (${signal})`);
      }
    }).catch(() => {
      process.exitCode = 1;
      console.error(`API shutdown could not disconnect Prisma cleanly (${signal})`);
    });
  });
}

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));
