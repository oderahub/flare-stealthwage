"use client";

/**
 * Wallet providers, scoped to /app only.
 *
 * Deliberately NOT in the root layout: `/` and `/verify/[id]` must stay
 * wallet-free so they load for a judge arriving cold, and so they keep working
 * when the FCC extension tunnel is down.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { WagmiProvider } from "wagmi";

import { wagmiConfig } from "../../lib/wagmi";

export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(() => new QueryClient());
  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </WagmiProvider>
  );
}
