"use client";

/**
 * /verify/[id] — public audit record. No wallet, no extension, RPC only.
 *
 * This is the link you paste into a chat: it survives the FCC tunnel being
 * down, and anyone can open it cold.
 *
 * WHERE THE TERMS COME FROM, and why it is not the event log:
 * the Coston2 public RPC caps eth_getLogs at 30 blocks, so scanning history for
 * a TermsRevealed event is not possible for an arbitrary stream. But that turns
 * out to model auditing better anyway — an auditor is *given* the terms by the
 * employer and wants to check them against the chain. Discovery was never the
 * job. So terms are accepted from, in order:
 *
 *   1. the ?terms= query parameter (makes the whole verdict shareable in a URL)
 *   2. a pinned reveal block, for the demo stream only
 *   3. a paste box
 *
 * The check itself is the same in every case and runs in the visitor's browser:
 * keccak256(terms) === the commitment stored on chain.
 */

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useParams, useSearchParams } from "next/navigation";
import { formatUnits, isHex, keccak256, type Hex } from "viem";

import { RATE_SCALE, accruedAt, decodeTerms, type StreamTerms } from "@protocol";
import {
  DEMO_STREAM_ID,
  EXPLORER,
  VAULT_ADDRESS,
  readRevealedTerms,
  readStream,
  readTokenMeta,
  short,
  type OnChainStream,
} from "../../../lib/chain";

type Verdict = "match" | "mismatch" | "absent";

export default function VerifyPage() {
  return (
    <Suspense fallback={<Shell><p className="label">loading…</p></Shell>}>
      <Verify />
    </Suspense>
  );
}

function Verify() {
  const params = useParams<{ id: string }>();
  const search = useSearchParams();
  const streamId = useMemo(() => {
    try {
      return BigInt(params.id);
    } catch {
      return null;
    }
  }, [params.id]);

  const [stream, setStream] = useState<OnChainStream | null>(null);
  const [meta, setMeta] = useState<{ decimals: number; symbol: string } | null>(null);
  const [termsHex, setTermsHex] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // Load the on-chain record. This is contract STORAGE, not logs, so it works
  // for any stream id regardless of the getLogs range limit.
  useEffect(() => {
    if (streamId == null) {
      setError("Not a valid stream id.");
      setLoading(false);
      return;
    }
    (async () => {
      try {
        const s = await readStream(streamId);
        if (s.employer === "0x0000000000000000000000000000000000000000") {
          setError(`Stream #${streamId} does not exist in this vault.`);
          setStream(null);
        } else {
          setStream(s);
          setMeta(await readTokenMeta(s.token));
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    })();
  }, [streamId]);

  // Seed the terms box: query param first, then the pinned demo reveal.
  useEffect(() => {
    const fromUrl = search.get("terms");
    if (fromUrl) {
      setTermsHex(fromUrl);
      return;
    }
    if (streamId != null && streamId === DEMO_STREAM_ID) {
      void readRevealedTerms(streamId).then((t) => t && setTermsHex(t));
    }
  }, [search, streamId]);

  const trimmed = termsHex.trim();
  const termsValid = trimmed.length > 2 && isHex(trimmed);

  const computed = useMemo(() => {
    if (!termsValid) return null;
    try {
      return keccak256(trimmed as Hex);
    } catch {
      return null;
    }
  }, [trimmed, termsValid]);

  const verdict: Verdict = !computed
    ? "absent"
    : stream && computed.toLowerCase() === stream.commitment.toLowerCase()
      ? "match"
      : "mismatch";

  const decoded: StreamTerms | null = useMemo(() => {
    if (verdict !== "match") return null;
    try {
      return decodeTerms(trimmed as Hex);
    } catch {
      return null;
    }
  }, [verdict, trimmed]);

  const shareUrl = useCallback(() => {
    if (typeof window === "undefined" || !termsValid) return "";
    const u = new URL(window.location.href);
    u.searchParams.set("terms", trimmed);
    return u.toString();
  }, [trimmed, termsValid]);

  const fmt = (v: bigint | null | undefined, dp = 6) =>
    v == null || !meta ? "—" : Number(formatUnits(v, meta.decimals)).toFixed(dp);

  const perDay =
    decoded && meta
      ? formatUnits(
          (decoded.ratePerSecond * 86_400n + RATE_SCALE / 2n) / RATE_SCALE,
          meta.decimals,
        )
      : null;

  return (
    <Shell>
      <header className="border-b-2 border-rule pb-8">
        <div className="label">StealthWage · audit record</div>
        <h1 className="mt-3 text-3xl font-semibold tracking-tight sm:text-4xl">
          Verify stream #{params.id}
        </h1>
        <p className="mt-4 max-w-xl text-[15px] leading-relaxed text-ink-muted">
          Check a set of stream terms against the commitment stored on Flare.
          Everything below is computed in your browser from public chain data —
          no wallet, no server, nothing to trust here.
        </p>
      </header>

      {loading && <p className="mt-8 label">reading Coston2…</p>}

      {error && (
        <p className="mt-8 border-l-2 border-danger py-2 pl-4 font-mono text-[13px] text-danger">
          {error}
        </p>
      )}

      {stream && (
        <>
          {/* ── Verdict ─────────────────────────────────────────────────── */}
          <section className="mt-10">
            <h2 className="label">Verdict</h2>
            <div className="mt-4">
              {verdict === "match" && (
                <p className="border-l-2 border-success py-3 pl-4">
                  <span className="block font-mono text-lg text-success">
                    Terms match the on-chain commitment.
                  </span>
                  <span className="mt-1 block font-mono text-[12px] text-ink-muted">
                    keccak256(terms) == commitment
                  </span>
                </p>
              )}
              {verdict === "mismatch" && (
                <p className="border-l-2 border-danger py-3 pl-4">
                  <span className="block font-mono text-lg text-danger">
                    These terms do NOT match this stream.
                  </span>
                  <span className="mt-1 block font-mono text-[12px] text-ink-muted">
                    The published terms have been altered, or they belong to a
                    different stream.
                  </span>
                </p>
              )}
              {verdict === "absent" && (
                <p className="border-l-2 border-rule-2 py-3 pl-4 font-mono text-[13px] text-ink-muted">
                  No terms supplied yet. Paste them below, or open a link that
                  carries them.
                </p>
              )}
            </div>
          </section>

          {/* ── The two hashes, side by side ────────────────────────────── */}
          <section className="mt-10 border-t border-rule-2 pt-6">
            <h2 className="label">The comparison</h2>
            <dl className="mt-5 space-y-5">
              <div>
                <dt className="label">commitment stored on chain</dt>
                <dd className="mt-1.5 break-all font-mono text-[13px]">
                  {stream.commitment}
                </dd>
              </div>
              <div>
                <dt className="label">keccak256 of the supplied terms</dt>
                <dd
                  className={`mt-1.5 break-all font-mono text-[13px] ${
                    verdict === "match"
                      ? "text-success"
                      : verdict === "mismatch"
                        ? "text-danger"
                        : "text-ink-subtle"
                  }`}
                >
                  {computed ?? "—"}
                </dd>
              </div>
            </dl>
          </section>

          {/* ── Decoded terms ──────────────────────────────────────────── */}
          {decoded && meta && (
            <section className="mt-10 border-t border-rule-2 pt-6">
              <h2 className="label">Terms, decoded</h2>
              <dl className="mt-5 grid gap-5 sm:grid-cols-2">
                <Field label="employer">
                  <Mono>{short(decoded.employer)}</Mono>
                </Field>
                <Field label="recipient">
                  <Mono>{short(decoded.recipient)}</Mono>
                </Field>
                <Field label="rate">
                  <Mono>
                    {perDay} {meta.symbol}/day
                  </Mono>
                </Field>
                <Field label="total cap">
                  <Mono>
                    {fmt(decoded.total, 2)} {meta.symbol}
                  </Mono>
                </Field>
                <Field label="started">
                  <Mono>
                    {new Date(Number(decoded.startTime) * 1000)
                      .toISOString()
                      .slice(0, 16)
                      .replace("T", " ")}
                  </Mono>
                </Field>
                <Field label="accrued to date">
                  <Mono>
                    {fmt(accruedAt(decoded, BigInt(Math.floor(Date.now() / 1000))))}{" "}
                    {meta.symbol}
                  </Mono>
                </Field>
                <Field label="funded on chain">
                  <Mono>
                    {fmt(stream.funded, 2)} {meta.symbol}
                  </Mono>
                </Field>
                <Field label="withdrawn on chain">
                  <Mono>
                    {fmt(stream.withdrawn)} {meta.symbol}
                  </Mono>
                </Field>
              </dl>
            </section>
          )}

          {/* ── Input ──────────────────────────────────────────────────── */}
          <section className="mt-10 border-t border-rule-2 pt-6">
            <h2 className="label">Terms (ABI-encoded hex)</h2>
            <textarea
              className="mt-4 h-28 w-full resize-y border border-rule bg-surface-elev p-3 font-mono text-[12px] leading-relaxed text-ink outline-none focus:border-accent"
              placeholder="0x…"
              value={termsHex}
              onChange={(e) => setTermsHex(e.target.value)}
              spellCheck={false}
            />
            {trimmed.length > 2 && !termsValid && (
              <p className="mt-2 font-mono text-[12px] text-warn">
                Not valid hex — terms should start with 0x.
              </p>
            )}
            {termsValid && (
              <button
                type="button"
                className="mt-3 border border-rule px-3 py-1.5 font-mono text-[12px] text-ink hover:border-accent hover:text-accent"
                onClick={() => void navigator.clipboard?.writeText(shareUrl())}
              >
                Copy shareable verification link
              </button>
            )}
          </section>

          {/* ── Honest scope ───────────────────────────────────────────── */}
          <section className="mt-10 border-t border-rule pt-6">
            <h2 className="label">What this does and does not prove</h2>
            <ul className="mt-5 space-y-4 text-[14px] leading-relaxed text-ink-muted">
              <li className="border-l border-rule-2 pl-4">
                It proves these exact terms produced the commitment this vault
                stores for stream #{params.id}. The employer cannot show one set
                of terms here and have enforced another.
              </li>
              <li className="border-l border-rule-2 pl-4">
                It does not prove the employer funded the stream adequately, nor
                that they have not cancelled it. Those are separate on-chain
                facts, shown above as funded and withdrawn.
              </li>
              <li className="border-l border-rule-2 pl-4">
                Revealing terms is voluntary. A stream with no published terms is
                not suspicious — confidentiality is the default, and disclosure
                is the exception the employer chooses.
              </li>
            </ul>
          </section>

          <footer className="mt-12 border-t-2 border-rule pt-5 font-mono text-[11px] text-ink-subtle">
            <a
              className="text-accent underline decoration-rule-2 underline-offset-4"
              href={`${EXPLORER}/address/${VAULT_ADDRESS}`}
              target="_blank"
              rel="noreferrer"
            >
              StreamVault {short(VAULT_ADDRESS)}
            </a>{" "}
            · Flare Coston2
          </footer>
        </>
      )}
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto w-full max-w-3xl flex-1 px-6 py-14 sm:px-8">{children}</main>
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
