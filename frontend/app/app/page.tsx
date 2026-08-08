"use client";

/**
 * /app — employer: create a confidential stream.
 *
 * THE PREVIEW PANEL IS THE POINT. Before anything is signed, the employer sees
 * exactly what will be published (a commitment, a ciphertext, the counterparty)
 * against what will not (rate, total, salary). That is the moment privacy stops
 * being a claim in a README and becomes something a user can see.
 *
 * The preview is not a mock-up: it runs the real `encodeTerms`/`commitTo` from
 * the shared protocol module and the real ECIES seal, so the hash shown here is
 * byte-identical to the one that lands on chain.
 */

import { useCallback, useMemo, useState } from "react";
import {
  formatUnits,
  keccak256,
  parseUnits,
  toBytes,
  type Hex,
} from "viem";
import {
  useAccount,
  useConnect,
  useDisconnect,
  usePublicClient,
  useWalletClient,
} from "wagmi";

import {
  RATE_SCALE,
  commitTo,
  encodeTerms,
  ratePerDayToScaled,
  type StreamTerms,
} from "@protocol";
import {
  CHAIN_ID,
  ERC20_ABI,
  EXPLORER,
  VAULT_ABI,
  VAULT_ADDRESS,
  short,
} from "../../lib/chain";

const TEE_ECIES_PUBKEY =
  process.env.NEXT_PUBLIC_TEE_ECIES_PUBKEY ??
  "0307d72d503f4f09a323aeccd1740715537af9e471d9f4d172524d6f6cc431c2e1";

const TOKENS = [
  { label: "FXRP", address: "0x0b6a3645c240605887a5532109323a3e12273dc7" as Hex },
  { label: "USDT0", address: "0xc1a5b41512496b80903d1f32d6dea3a73212e71f" as Hex },
];

type Phase = "idle" | "sealing" | "creating" | "approving" | "funding" | "done" | "error";

export default function EmployerPage() {
  const { address, isConnected, chainId } = useAccount();
  const { connect, connectors } = useConnect();
  const { disconnect } = useDisconnect();
  const publicClient = usePublicClient();
  const { data: walletClient } = useWalletClient();

  const [recipient, setRecipient] = useState("");
  const [token, setToken] = useState<Hex>(TOKENS[1].address);
  const [perDay, setPerDay] = useState("0.25");
  const [totalCap, setTotalCap] = useState("100");
  const [fundAmount, setFundAmount] = useState("8");
  const [decimals] = useState(6); // both demo tokens are 6dp

  const [phase, setPhase] = useState<Phase>("idle");
  const [message, setMessage] = useState<string | null>(null);
  const [result, setResult] = useState<{ streamId: string; tx: Hex } | null>(null);

  // A fresh salt per draft. Rates are low-entropy; without this the commitment
  // could be brute-forced straight off the explorer.
  const [salt] = useState<Hex>(() =>
    keccak256(toBytes(`sw-${Date.now()}-${Math.random()}`)),
  );

  const recipientValid = /^0x[0-9a-fA-F]{40}$/.test(recipient.trim());

  /** The real terms object — same encoder the enclave decodes with. */
  const draft: StreamTerms | null = useMemo(() => {
    if (!address || !recipientValid) return null;
    try {
      return {
        employer: address as Hex,
        recipient: recipient.trim() as Hex,
        token,
        ratePerSecond: ratePerDayToScaled(parseUnits(perDay || "0", decimals)),
        total: parseUnits(totalCap || "0", decimals),
        startTime: BigInt(Math.floor(Date.now() / 1000)),
        salt,
      };
    } catch {
      return null;
    }
  }, [address, recipient, recipientValid, token, perDay, totalCap, decimals, salt]);

  const commitment = useMemo(() => (draft ? commitTo(draft) : null), [draft]);

  const submit = useCallback(async () => {
    if (!draft || !walletClient || !publicClient || !commitment) return;
    setResult(null);
    try {
      setPhase("sealing");
      setMessage("Sealing terms to the enclave key…");
      const { encrypt } = await import("eciesjs");
      const termsHex = encodeTerms(draft);
      const sealed = encrypt(
        TEE_ECIES_PUBKEY,
        Uint8Array.from(termsHex.slice(2).match(/.{2}/g)!.map((h) => parseInt(h, 16))),
      );
      const encryptedTerms = `0x${Array.from(new Uint8Array(sealed), (b) =>
        b.toString(16).padStart(2, "0"),
      ).join("")}` as Hex;

      setPhase("creating");
      setMessage("Publishing the commitment…");
      const createHash = await walletClient.writeContract({
        address: VAULT_ADDRESS,
        abi: VAULT_ABI,
        functionName: "createStream",
        args: [draft.recipient, draft.token, commitment, draft.startTime, encryptedTerms],
      });
      const rcpt = await publicClient.waitForTransactionReceipt({ hash: createHash });
      if (rcpt.status !== "success") throw new Error("createStream reverted");

      let streamId = "";
      for (const log of rcpt.logs) {
        if (log.topics[0] && log.topics.length > 1 && log.address.toLowerCase() === VAULT_ADDRESS.toLowerCase()) {
          try {
            streamId = BigInt(log.topics[1]!).toString();
            break;
          } catch { /* not the one */ }
        }
      }

      const fund = parseUnits(fundAmount || "0", decimals);
      if (fund > 0n && streamId) {
        setPhase("approving");
        setMessage("Approving the vault to move your tokens…");
        const approveHash = await walletClient.writeContract({
          address: draft.token,
          abi: ERC20_ABI,
          functionName: "approve",
          args: [VAULT_ADDRESS, fund],
        });
        await publicClient.waitForTransactionReceipt({ hash: approveHash });

        setPhase("funding");
        setMessage("Funding the stream…");
        const fundHash = await walletClient.writeContract({
          address: VAULT_ADDRESS,
          abi: VAULT_ABI,
          functionName: "fund",
          args: [BigInt(streamId), fund],
        });
        await publicClient.waitForTransactionReceipt({ hash: fundHash });
      }

      setPhase("done");
      setMessage(null);
      setResult({ streamId, tx: createHash });
    } catch (e) {
      setPhase("error");
      setMessage(e instanceof Error ? e.message.split("\n")[0] : String(e));
    }
  }, [draft, walletClient, publicClient, commitment, fundAmount, decimals]);

  const busy = ["sealing", "creating", "approving", "funding"].includes(phase);
  const wrongChain = isConnected && chainId !== CHAIN_ID;

  return (
    <main className="mx-auto w-full max-w-4xl flex-1 px-6 py-14 sm:px-8">
      <header className="border-b-2 border-rule pb-8">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="label">StealthWage · employer</div>
            <h1 className="mt-3 text-3xl font-semibold tracking-tight sm:text-4xl">
              Open a confidential stream
            </h1>
          </div>
          <div className="text-right font-mono text-[12px]">
            {isConnected ? (
              <>
                <div className="text-ink">{short(address!)}</div>
                <button
                  className="mt-1 text-ink-subtle underline decoration-rule-2 underline-offset-4 hover:text-accent"
                  onClick={() => disconnect()}
                >
                  disconnect
                </button>
              </>
            ) : (
              connectors.slice(0, 1).map((c) => (
                <button
                  key={c.uid}
                  className="border border-rule px-3 py-1.5 text-ink hover:border-accent hover:text-accent"
                  onClick={() => connect({ connector: c })}
                >
                  Connect wallet
                </button>
              ))
            )}
          </div>
        </div>
        {wrongChain && (
          <p className="mt-5 border-l-2 border-warn py-2 pl-4 font-mono text-[12px] text-warn">
            Wrong network — switch your wallet to Coston2 (chain {CHAIN_ID}).
          </p>
        )}
      </header>

      <div className="mt-10 grid gap-10 md:grid-cols-2 md:gap-0">
        {/* ── Form ──────────────────────────────────────────────────────── */}
        <section className="md:pr-10">
          <h2 className="label">Stream terms</h2>
          <div className="mt-5 space-y-5">
            <Input
              label="recipient address"
              value={recipient}
              onChange={setRecipient}
              placeholder="0x…"
              invalid={recipient.length > 0 && !recipientValid}
              hint={
                recipient.length > 0 && !recipientValid
                  ? "Must be a 20-byte address"
                  : undefined
              }
            />
            <div>
              <label className="label">token</label>
              <div className="mt-1.5 flex gap-2">
                {TOKENS.map((t) => (
                  <button
                    key={t.address}
                    type="button"
                    onClick={() => setToken(t.address)}
                    className={`border px-3 py-1.5 font-mono text-[12px] ${
                      token === t.address
                        ? "border-accent text-accent"
                        : "border-rule text-ink-muted hover:border-accent"
                    }`}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
            </div>
            <Input label="rate per day" value={perDay} onChange={setPerDay} mono />
            <Input label="total cap" value={totalCap} onChange={setTotalCap} mono />
            <Input
              label="fund now"
              value={fundAmount}
              onChange={setFundAmount}
              mono
              hint="Transferred to the vault. Can be topped up later."
            />
          </div>
        </section>

        {/* ── Preview — the screen that matters ─────────────────────────── */}
        <section className="border-t border-rule-2 pt-10 md:border-l md:border-t-0 md:pl-10 md:pt-0">
          <h2 className="label">Before you sign</h2>

          <div className="mt-5">
            <h3 className="font-mono text-[11px] uppercase tracking-[0.08em] text-ink-muted">
              Published on chain
            </h3>
            <dl className="mt-4 space-y-4">
              <Field label="commitment">
                <span className="block break-all font-mono text-[12px] leading-snug">
                  {commitment ?? <span className="text-ink-subtle">fill the form…</span>}
                </span>
              </Field>
              <Field label="recipient">
                <Mono>{recipientValid ? short(recipient.trim()) : "—"}</Mono>
              </Field>
              <Field label="token">
                <Mono>{TOKENS.find((t) => t.address === token)?.label}</Mono>
              </Field>
              <Field label="amount funded">
                <Mono>{fundAmount || "0"}</Mono>
              </Field>
              <Field label="sealed terms">
                <Mono>~321 bytes of ciphertext</Mono>
              </Field>
            </dl>
          </div>

          <div className="mt-8 border-t border-rule-2 pt-6">
            <h3 className="font-mono text-[11px] uppercase tracking-[0.08em] text-ink-muted">
              Never published
            </h3>
            <dl className="mt-4 space-y-4">
              <Field label="rate">
                <Redacted>
                  {perDay} / day
                </Redacted>
              </Field>
              <Field label="total cap">
                <Redacted>{totalCap}</Redacted>
              </Field>
              <Field label="implied salary">
                <Redacted>
                  {perDay ? `${(Number(perDay) * 30).toFixed(2)} / month` : "—"}
                </Redacted>
              </Field>
            </dl>
            <p className="mt-5 text-[13px] leading-relaxed text-ink-muted">
              These values are sealed to the enclave&apos;s public key in your
              browser. They are recoverable only by the enclave — and later, if
              you choose, by publishing them yourself through Audit Mode.
            </p>
          </div>
        </section>
      </div>

      {/* ── Submit ───────────────────────────────────────────────────────── */}
      <section className="mt-10 border-t border-rule pt-6">
        <button
          type="button"
          disabled={!isConnected || !draft || busy || wrongChain}
          onClick={() => void submit()}
          className="border border-rule px-4 py-2 font-mono text-[13px] text-ink enabled:hover:border-accent enabled:hover:text-accent disabled:cursor-not-allowed disabled:text-ink-subtle"
        >
          {busy ? "working…" : "Seal terms and open stream"}
        </button>

        {!isConnected && (
          <p className="mt-3 font-mono text-[12px] text-ink-subtle">
            Connect a wallet to continue.
          </p>
        )}

        {message && (
          <p
            className={`mt-4 border-l-2 py-2 pl-4 font-mono text-[12px] ${
              phase === "error" ? "border-danger text-danger" : "border-accent text-ink-muted"
            }`}
          >
            {message}
          </p>
        )}

        {result && (
          <div className="mt-5 border-l-2 border-success py-3 pl-4">
            <p className="font-mono text-[14px] text-success">
              Stream #{result.streamId} is open.
            </p>
            <ul className="mt-2 space-y-1 font-mono text-[12px]">
              <li>
                <a
                  className="text-accent underline decoration-rule-2 underline-offset-4"
                  href={`${EXPLORER}/tx/${result.tx}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  creation transaction
                </a>
              </li>
              <li>
                <a
                  className="text-accent underline decoration-rule-2 underline-offset-4"
                  href={`/verify/${result.streamId}`}
                >
                  public audit record
                </a>
              </li>
            </ul>
          </div>
        )}
      </section>

      <footer className="mt-14 border-t-2 border-rule pt-5 font-mono text-[11px] text-ink-subtle">
        <a className="text-accent underline decoration-rule-2 underline-offset-4" href="/">
          ← StealthWage
        </a>{" "}
        · vault {short(VAULT_ADDRESS)} · Coston2
      </footer>
    </main>
  );
}

function Input({
  label, value, onChange, placeholder, mono, hint, invalid,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  mono?: boolean;
  hint?: string;
  invalid?: boolean;
}) {
  return (
    <div>
      <label className="label">{label}</label>
      <input
        className={`mt-1.5 w-full border bg-surface-elev px-3 py-2 text-[13px] text-ink outline-none focus:border-accent ${
          invalid ? "border-danger" : "border-rule"
        } ${mono ? "font-mono" : "font-mono"}`}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        spellCheck={false}
      />
      {hint && (
        <p className={`mt-1 text-[11px] ${invalid ? "text-danger" : "text-ink-subtle"}`}>
          {hint}
        </p>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="label">{label}</dt>
      <dd className="mt-1.5">{children}</dd>
    </div>
  );
}

const Mono = ({ children }: { children: React.ReactNode }) => (
  <span className="font-mono text-[13px] tabular-nums">{children}</span>
);

/** Shows the value struck through — you can read it, the chain cannot. */
const Redacted = ({ children }: { children: React.ReactNode }) => (
  <span className="inline-flex items-baseline gap-2">
    <span className="font-mono text-[13px] tabular-nums text-ink-muted line-through decoration-danger/60">
      {children}
    </span>
    <span className="font-mono text-[10px] uppercase tracking-wide text-ink-subtle">
      sealed
    </span>
  </span>
);
