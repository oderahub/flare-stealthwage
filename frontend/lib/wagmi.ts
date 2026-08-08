"use client";

/**
 * Wallet layer — only /app and the recipient dashboard need this.
 *
 * `/` and `/verify/[id]` deliberately do NOT import it: those routes must work
 * for a judge with no wallet, and must survive the FCC tunnel being down.
 */
import { createConfig, http } from "wagmi";
import { injected } from "wagmi/connectors";

import { RPC_URL, coston2 } from "./chain";

export const wagmiConfig = createConfig({
  chains: [coston2],
  connectors: [injected()],
  transports: { [coston2.id]: http(RPC_URL) },
  ssr: true,
});

declare module "wagmi" {
  interface Register {
    config: typeof wagmiConfig;
  }
}
