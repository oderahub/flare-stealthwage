"use client";

/**
 * Landing page — the highest-value screen, in Lane B "Document Grade".
 *
 * The split panel is the product argument: left is what anyone reads off the
 * chain, right is what the recipient actually sees. Both are LIVE. The right
 * column is not fiction — the employer published the terms via Audit Mode
 * (revealTerms), so the browser reads plaintext from the TermsRevealed event
 * and verifies keccak256(terms) == the on-chain commitment, in front of the
 * visitor.
 *
 * No wallet. This route touches the chain over RPC only, so it survives the FCC
 * extension tunnel being down — which matters, because judging runs Aug 15-21
 * and a laptop tunnel will not survive a week unattended.
 *
 * The accrual ticker is pure local arithmetic through the shared `accruedAt` —
 * the same function the enclave signs with. It costs no RPC call, so open tabs
 * don't hammer a rate-limited public endpoint.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { formatUnits, keccak256, type Hex } from "viem";

import { RATE_SCALE, accruedAt, decodeTerms, type StreamTerms } from "@protocol";
import {
  CHAIN_ID,
  DEMO_STREAM_ID,
  EXPLORER,
  VAULT_ADDRESS,
  readRevealedTerms,
  readStream,
  readTokenMeta,
  short,
  type OnChainStream,
} from "../lib/chain";

const FAUCET = "https://faucet.flare.network/coston2";
const WITHDRAW_TX =
  "0x347bc3183a47f1f8fbea30f3bc5257bd0181d0f40be308e4bead1ea97a9e4ccb";

interface Loaded {
  stream: OnChainStream;
  terms: StreamTerms | null;
  commitmentVerified: boolean;
  decimals: number;
  symbol: string;
}

export default function Landing() {
  const [data, setData] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => BigInt(Math.floor(Date.now() / 1000)));

  const load = useCallback(async () => {
    try {
      const stream = await readStream(DEMO_STREAM_ID);
      const [{ decimals, symbol }, termsHex] = await Promise.all([
        readTokenMeta(stream.token),
        readRevealedTerms(DEMO_STREAM_ID),
      ]);

      let terms: StreamTerms | null = null;
      let commitmentVerified = false;
      if (termsHex) {
        // Verified here, client-side, rather than trusting the event: this is
        // the Audit Mode guarantee performed where anyone can check it.
        commitmentVerified =
          keccak256(termsHex).toLowerCase() === stream.commitment.toLowerCase();
        if (commitmentVerified) terms = decodeTerms(termsHex);
      }

      setData({ stream, terms, commitmentVerified, decimals, symbol });
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void load();
    const id = setInterval(() => void load(), 15_000);
    return () => clearInterval(id);
  }, [load]);

  useEffect(() => {
    const id = setInterval(() => setNow(BigInt(Math.floor(Date.now() / 1000))), 1000);
    return () => clearInterval(id);
  }, []);

  const accrued = useMemo(
    () => (data?.terms ? accruedAt(data.terms, now) : null),
    [data, now],
  );

  const fmt = (v: bigint | null | undefined, dp = 6) =>
    v == null || !data ? "—" : Number(formatUnits(v, data.decimals)).toFixed(dp);

  // Round, don't truncate, converting fixed-point rate back to tokens/day:
  // flooring twice renders 0.25 as 0.249999, which reads as a bug.
  const perDay = data?.terms
    ? formatUnits(
        (data.terms.ratePerSecond * 86_400n + RATE_SCALE / 2n) / RATE_SCALE,
        data.decimals,
      )
    : null;

  return (
    <main className="mx-auto w-full max-w-4xl flex-1 px-6 py-14 sm:px-8">
      {/* ── Masthead ─────────────────────────────────────────────────────── */}
      <header className="border-b-2 border-rule pb-8">
        <div className="label">Flare Confidential Compute · Coston2</div>
        <h1 className="mt-3 text-4xl font-semibold leading-[1.05] tracking-tight sm:text-5xl">
          Private payroll on Flare.
        </h1>
        <p className="mt-4 max-w-xl text-[15px] leading-relaxed text-ink-muted">
          Stream salaries where the chain proves the payment but never reveals
          the amount. Terms are sealed to a confidential compute enclave; only a
          commitment reaches the explorer.
        </p>
        <p className="mt-4 max-w-xl text-[15px] leading-relaxed text-ink-muted">
          We call this <span className="text-ink">selective transparency</span>.
          Confidentiality is the default; disclosure is a deliberate choice.
        </p>

        <dl className="mt-7 flex flex-wrap gap-x-8 gap-y-3 font-mono text-xs">
          {[
            ["network", "Coston2"],
            ["chain", String(CHAIN_ID)],
            ["enclave", "FCC (simulated)"],
            ["asset", data?.symbol ?? "…"],
          ].map(([k, v]) => (
            <div key={k}>
              <dt className="label">{k}</dt>
              <dd className="mt-1 text-ink">{v}</dd>
            </div>
          ))}
        </dl>
      </header>

      {/* ── The split panel ──────────────────────────────────────────────── */}
      <section className="mt-12">
        <div className="flex items-baseline justify-between gap-4 border-b border-rule-2 pb-2">
          <h2 className="label">The same stream, two views</h2>
          <span className="flex items-center gap-2 font-mono text-[11px] text-ink-subtle">
            <span className="live-dot inline-block h-1.5 w-1.5 rounded-full bg-accent" />
            live · stream #{DEMO_STREAM_ID.toString()}
          </span>
        </div>

        {error && (
          <p className="mt-4 border-l-2 border-danger py-2 pl-4 font-mono text-xs text-danger">
            Could not reach Coston2 — {error}
          </p>
        )}

        <div className="mt-8 grid gap-10 md:grid-cols-2 md:gap-0">
          {/* Public */}
          <div className="md:pr-10">
            <h3 className="font-mono text-[11px] uppercase tracking-[0.08em] text-ink-muted">
              What the chain sees
              <span className="ml-2 text-ink-subtle">· public</span>
            </h3>
            <dl className="mt-5 space-y-4">
              <Field label="commitment">
                <span className="block break-all font-mono text-[13px] leading-snug">
                  {data?.stream.commitment ?? "…"}
                </span>
              </Field>
              <Field label="funded">
                <Num>{fmt(data?.stream.funded, 2)}</Num>{" "}
                <Unit>{data?.symbol}</Unit>
              </Field>
              <Field label="withdrawn">
                <Num>{fmt(data?.stream.withdrawn, 6)}</Num>{" "}
                <Unit>{data?.symbol}</Unit>
              </Field>
              <Field label="recipient">
                <span className="font-mono text-[13px]">
                  {data ? short(data.stream.recipient) : "…"}
                </span>
              </Field>
              <Field label="rate">
                <Redacted />
              </Field>
              <Field label="salary">
                <Redacted />
              </Field>
            </dl>
          </div>

          {/* Private — separated by a rule, not a box */}
          <div className="border-t border-rule-2 pt-10 md:border-l md:border-t-0 md:pl-10 md:pt-0">
            <h3 className="font-mono text-[11px] uppercase tracking-[0.08em] text-ink-muted">
              What the recipient sees
              <span className="ml-2 text-ink-subtle">· revealed</span>
            </h3>
            <dl className="mt-5 space-y-4">
              <Field label="rate">
                <Num>{perDay ?? "…"}</Num> <Unit>{data?.symbol}/day</Unit>
              </Field>
              <Field label="accrued">
                <span className="font-mono text-2xl tabular-nums tracking-tight text-accent">
                  {fmt(accrued)}
                </span>{" "}
                <Unit>{data?.symbol}</Unit>
              </Field>
              <Field label="total cap">
                <Num>{fmt(data?.terms?.total, 2)}</Num>{" "}
                <Unit>{data?.symbol}</Unit>
              </Field>
              <Field label="started">
                <span className="font-mono text-[13px]">
                  {data?.terms
                    ? new Date(Number(data.terms.startTime) * 1000)
                        .toISOString()
                        .slice(0, 16)
                        .replace("T", " ")
                    : "…"}
                </span>
              </Field>
              <Field label="proof">
                {data?.commitmentVerified ? (
                  <span className="font-mono text-[12px] text-success">
                    keccak256(terms) == commitment ✓
                  </span>
                ) : data ? (
                  <span className="font-mono text-[12px] text-ink-subtle">
                    terms not revealed
                  </span>
                ) : (
                  <span className="font-mono text-[12px] text-ink-subtle">…</span>
                )}
              </Field>
            </dl>
          </div>
        </div>

        <p className="mt-8 max-w-2xl text-[13px] leading-relaxed text-ink-muted">
          Both columns read live from Coston2. The right-hand terms are public
          only because this employer chose to publish them — your browser
          re-hashes that plaintext against the on-chain commitment on the left.
          The accrued figure advances locally using the same function the
          enclave signs with.
        </p>
      </section>

      {/* ── Entry points ─────────────────────────────────────────────────── */}
      <section className="mt-12 border-t border-rule pt-8">
        <h2 className="label">Use it</h2>
        <p className="mt-4 max-w-2xl text-[13px] leading-relaxed text-ink-muted">
          Everything above is read-only and needs no wallet. The two screens
          below do — they sign transactions on Coston2 (chain {CHAIN_ID}).
        </p>
        <div className="mt-5 flex flex-wrap gap-3">
          <a
            href="/app"
            className="border border-rule px-4 py-2 font-mono text-[13px] text-ink hover:border-accent hover:text-accent"
          >
            Open a stream →
            <span className="ml-2 text-ink-subtle">employer</span>
          </a>
          <a
            href={`/stream/${DEMO_STREAM_ID}`}
            className="border border-rule px-4 py-2 font-mono text-[13px] text-ink hover:border-accent hover:text-accent"
          >
            Withdraw →
            <span className="ml-2 text-ink-subtle">recipient</span>
          </a>
          <a
            href={`/verify/${DEMO_STREAM_ID}`}
            className="border border-rule px-4 py-2 font-mono text-[13px] text-ink hover:border-accent hover:text-accent"
          >
            Audit this stream →
            <span className="ml-2 text-ink-subtle">no wallet</span>
          </a>
        </div>
        <p className="mt-4 max-w-2xl text-[13px] leading-relaxed text-ink-muted">
          Withdrawing also needs the confidential compute extension to be
          reachable. If it is offline the recipient screen says so plainly, and
          nothing else on this site is affected.
        </p>
      </section>

      {/* ── References ───────────────────────────────────────────────────── */}
      <section className="mt-12 border-t border-rule-2 pt-6">
        <h2 className="label">References</h2>
        <ul className="mt-4 space-y-2 font-mono text-[13px]">
          <Ref href={`${EXPLORER}/address/${VAULT_ADDRESS}`}>
            StreamVault — {short(VAULT_ADDRESS)}
          </Ref>
          <Ref href={`${EXPLORER}/tx/${WITHDRAW_TX}`}>
            A real confidential withdrawal
          </Ref>
          <Ref href={FAUCET}>Coston2 faucet — test tokens</Ref>
        </ul>
      </section>

      {/* ── How it works ─────────────────────────────────────────────────── */}
      <section className="mt-12 border-t border-rule pt-8">
        <h2 className="label">How it works</h2>
        <ol className="mt-5 space-y-5">
          <Step n="01">
            The employer&apos;s browser seals the stream terms to the
            enclave&apos;s public key. Plaintext never leaves the device.
          </Step>
          <Step n="02">
            <Mono>createStream</Mono> stores only keccak256(terms). The rate and
            the salary appear nowhere on chain.
          </Step>
          <Step n="03">
            To withdraw, the recipient signs a challenge. The confidential
            compute extension decrypts the terms, checks them against the
            commitment, computes accrual, and signs an authorization.
          </Step>
          <Step n="04">
            The vault verifies that signature with <Mono>ecrecover</Mono> and
            releases exactly what accrued. Remove the enclave and nothing can be
            withdrawn.
          </Step>
        </ol>
      </section>

      {/* ── Limitations, on the page rather than buried ──────────────────── */}
      <section className="mt-12 border-t border-rule pt-8">
        <h2 className="label">What this does not hide</h2>
        <ul className="mt-5 space-y-4 text-[14px] leading-relaxed text-ink-muted">
          <li className="border-l border-rule-2 pl-4">
            Withdrawal amounts and timing are public. Frequent, regular
            withdrawals leak the rate over time; irregular ones preserve more.
          </li>
          <li className="border-l border-rule-2 pl-4">
            The counterparty graph is visible — employer, recipient and token
            are on chain. What stays hidden is the rate, the total, and
            therefore the salary.
          </li>
          <li className="border-l border-rule-2 pl-4">
            This runs on a simulated TEE. Flare Confidential Compute is
            pre-production; the production path is Confidential Space
            attestation with enclave-held keys.
          </li>
        </ul>
      </section>

      <footer className="mt-14 border-t-2 border-rule pt-5 font-mono text-[11px] text-ink-subtle">
        StealthWage · Flare Coston2 · chain {CHAIN_ID}
      </footer>
    </main>
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

const Num = ({ children }: { children: React.ReactNode }) => (
  <span className="font-mono text-[15px] tabular-nums">{children}</span>
);

const Unit = ({ children }: { children: React.ReactNode }) => (
  <span className="font-mono text-[12px] text-ink-subtle">{children}</span>
);

const Mono = ({ children }: { children: React.ReactNode }) => (
  <code className="font-mono text-[13px] text-ink">{children}</code>
);

/** Deliberately typographic: absence is the point, so it gets a mark. */
const Redacted = () => (
  <span
    className="inline-block select-none bg-ink-subtle/25 font-mono text-[13px] text-transparent"
    aria-label="not on chain"
    title="not stored on chain"
  >
    ██████████
  </span>
);

function Step({ n, children }: { n: string; children: React.ReactNode }) {
  return (
    <li className="flex gap-5">
      <span className="shrink-0 font-mono text-[11px] text-ink-subtle">{n}</span>
      <span className="text-[14px] leading-relaxed text-ink-muted">{children}</span>
    </li>
  );
}

function Ref({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <li>
      <a
        className="text-accent underline decoration-rule-2 underline-offset-4 hover:text-accent-hover"
        href={href}
        target="_blank"
        rel="noreferrer"
      >
        {children}
      </a>
    </li>
  );
}
