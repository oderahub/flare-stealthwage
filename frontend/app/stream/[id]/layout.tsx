import { Providers } from "../../app/providers";

/** Wallet providers, scoped to this route — `/` and `/verify` stay wallet-free. */
export default function StreamLayout({ children }: { children: React.ReactNode }) {
  return <Providers>{children}</Providers>;
}
