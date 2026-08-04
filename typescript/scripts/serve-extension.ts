/**
 * Runs the FCC extension as a standalone process.
 *
 *   npm run serve            # listens on 18080
 *   EXTENSION_PORT=8080 npm run serve
 *
 * This is what the frontend talks to during local development and during the
 * demo recording. In the deployed topology the same server runs inside the TEE
 * container alongside tee-node; here it runs bare so you can drive it from a
 * browser without Docker.
 *
 * Requires TEE_ECIES_PRIVKEY and TEE_SIGNER_PRIVKEY in the environment
 * (set -a; . ./.env; set +a).
 */
import { VERSION } from "../src/app/config.js";
import { register, reportState } from "../src/app/handlers.js";
import { Server } from "../src/base/server.js";

const extPort = process.env.EXTENSION_PORT ?? "18080";
const signPort = process.env.SIGN_PORT ?? String(Number(extPort) + 1);

if (!process.env.TEE_ECIES_PRIVKEY || !process.env.TEE_SIGNER_PRIVKEY) {
  console.error(
    "TEE keys missing. Run:  set -a; . ./.env; set +a   (or npm run tee-keys)",
  );
  process.exit(1);
}

const server = new Server(extPort, signPort, VERSION, register, reportState);

const shutdown = (sig: string) => {
  console.log(`\n${sig} — shutting down`);
  server.close().then(() => process.exit(0), () => process.exit(1));
};
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

await server.listenAndServe();
console.log(`extension ready on http://127.0.0.1:${extPort}`);
