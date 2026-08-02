"use client";

/**
 * /stream/[id] — recipient dashboard.
 *
 * SIGN-THEN-FETCH. The recipient cannot decrypt their own terms: the blob is
 * sealed to the enclave's key, and an Ethereum key is not a decryption key. So
 * the flow is:
 *
 *   sign a challenge  →  enclave verifies you are a party named in the terms
 *                     →  returns the plaintext terms AND a signed authorization
 *                     →  cache terms, tick accrual locally, withdraw on demand
 *
 * Everything before the signature is public chain data. Nothing after it is
 * available to anyone who is not the recipient or the employer.
 *
 * This is the only screen that needs the enclave, so it is also the only screen
 * that can be broken by a dead tunnel. Failures are surfaced explicitly rather
 * than left as a spinner.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import { formatUnits, keccak256, type Hex } from "viem";
import { useAccount, useConnect, usePublicClient, useWalletClient } from "wagmi";

import {
  RATE_SCALE,
  WITHDRAW_TAG,
  accruedAt,
  buildCallerChallenge,
  decodeTerms,
  type StreamTerms,
} from "@protocol";
import {
  CHAIN_ID,
  EXPLORER,
  VAULT_ABI,
  VAULT_ADDRESS,
  fetchEncryptedTerms,
  readStream,
  readTokenMeta,
  short,
  type OnChainStream,
} from "@/lib/chain";
import { ENCLAVE_URL, requestAuthorization, type Authorization } from "@/lib/enclave";

export default function RecipientDashboard() {
  const params = useParams<{ id: string }>();
  const streamId = useMemo(() => {
    try {
      return BigInt(params.id);
    } catch {
      return null;
    }
  }, [params.id]);

  const { address, isConnected, chainId } = useAccount();
  const { connect, connectors } = useConnect();
  const publicClient = usePublicClient();
  const { data: walletClient } = useWalletClient();

  const [stream, setStream] = useState<OnChainStream | null>(null);
  const [meta, setMeta] = useState<{ decimals: number; symbol: string } | null>(null);
  const [sealed, setSealed] = useState<Hex | null>(null);
  const [chainError, setChainError] = useState<string | null>(null);

  const [terms, setTerms] = useState<StreamTerms | null>(null);
  const [auth, setAuth] = useState<Authorization | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [failure, setFailure] = useState<{ kind: string; detail: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [withdrawTx, setWithdrawTx] = useState<Hex | null>(null);

  const [now, setNow] = useState(() => BigInt(Math.floor(Date.now() / 1000)));
  useEffect(() => {
    const t = setInterval(() => setNow(BigInt(Math.floor(Date.now() / 1000))), 1000);
    return () => clearInterval(t);
  }, []);

  const loadChain = useCallback(async () => {
    if (streamId == null) return;
    try {
      const s = await readStream(streamId);
      if (s.employer === "0x0000000000000000000000000000000000000000") {
        setChainError(`Stream #${streamId} does not exist.`);
        return;
      }
      setStream(s);
      setMeta(await readTokenMeta(s.token));
      setSealed(await fetchEncryptedTerms(streamId));
      setChainError(null);
    } catch (e) {
      setChainError(e instanceof Error ? e.message : String(e));
    }
  }, [streamId]);

  useEffect(() => {
    void loadChain();
  }, [loadChain]);

  const isParty =
    !!address &&
    !!stream &&
    (address.toLowerCase() === stream.recipient.toLowerCase() ||
      address.toLowerCase() === stream.employer.toLowerCase());

  /** Sign the challenge, ask the enclave, cache the terms it returns. */
  const unlock = useCallback(async () => {
    if (!walletClient || !stream || !sealed || streamId == null) return;
    setBusy(true);
    setFailure(null);
    setStatus("Waiting for your signature…");
    try {
      const issuedAt = BigInt(Math.floor(Date.now() / 1000));
      const challenge = buildCallerChallenge({
        chainId: BigInt(CHAIN_ID),
        vault: VAULT_ADDRESS,
        streamId,
        commitment: stream.commitment,
        purpose: WITHDRAW_TAG,
        issuedAt,
      });
      const callerSignature = await walletClient.signMessage({
        message: { raw: challenge },
      });

      setStatus("Asking the enclave…");
      const res = await requestAuthorization({
        streamId: streamId.toString(),
        vault: VAULT_ADDRESS,
        chainId: String(CHAIN_ID),
        commitment: stream.commitment,
        encryptedTerms: sealed,
        issuedAt: issuedAt.toString(),
        callerSignature,
        command: "AUTH_WITHDRAW",
      });

      if (!res.ok) {
        setFailure(res.error);
        setStatus(null);
        return;
      }

      // Don't trust the returned terms — check them against the chain.
      if (keccak256(res.auth.terms).toLowerCase() !== stream.commitment.toLowerCase()) {
        setFailure({
          kind: "rejected",
          detail: "Enclave returned terms that do not match the on-chain commitment.",
        });
        setStatus(null);
        return;
      }

      setTerms(decodeTerms(res.auth.terms));
      setAuth(res.auth);
      setStatus(null);
    } catch (e) {
      setFailure({
        kind: "rejected",
        detail: e instanceof Error ? e.message.split("\n")[0] : String(e),
      });
      setStatus(null);
    } finally {
      setBusy(false);
    }
  }, [walletClient, stream, sealed, streamId]);

  const withdraw = useCallback(async () => {
    if (!walletClient || !publicClient || !auth || streamId == null) return;
    setBusy(true);
    setFailure(null);
    setStatus("Submitting withdrawal…");
    try {
      const hash = await walletClient.writeContract({
        address: VAULT_ADDRESS,
        abi: VAULT_ABI,
        functionName: "withdraw",
        args: [
          streamId,
          BigInt(auth.cumulativeAccrued),
          BigInt(auth.deadline),
          auth.signature,
        ],
      });
      const rcpt = await publicClient.waitForTransactionReceipt({ hash });
      if (rcpt.status !== "success") throw new Error("withdraw reverted");
      setWithdrawTx(hash);
      setAuth(null); // consumed; re-sign for a fresh one
      setStatus(null);
      await loadChain();
    } catch (e) {
      setFailure({
        kind: "rejected",
        detail: e instanceof Error ? e.message.split("\n")[0] : String(e),
      });
      setStatus(null);
    } finally {
      setBusy(false);
    }
  }, [walletClient, publicClient, auth, streamId, loadChain]);

  const accrued = terms ? accruedAt(terms, now) : null;
  const available =
    accrued != null && stream
      ? (accrued > stream.funded ? stream.funded : accrued) - stream.withdrawn
      : null;

  const fmt = (v: bigint | null | undefined, dp = 6) =>
    v == null || !meta ? "—" : Number(formatUnits(v, meta.decimals)).toFixed(dp);

  const perDay =
    terms && meta
      ? formatUnits(
          (terms.ratePerSecond * 86_400n + RATE_SCALE / 2n) / RATE_SCALE,
          meta.decimals,
        )
      : null;

  return (
    <main className="mx-auto w-full max-w-3xl flex-1 px-6 py-14 sm:px-8">
      <header className="border-b-2 border-rule pb-8">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="label">StealthWage · recipient</div>
            <h1 className="mt-3 text-3xl font-semibold tracking-tight sm:text-4xl">
              Stream #{params.id}
            </h1>
          </div>
          {!isConnected &&
            connectors.slice(0, 1).map((c) => (
              <button
                key={c.uid}
                className="border border-rule px-3 py-1.5 font-mono text-[12px] hover:border-accent hover:text-accent"
                onClick={() => connect({ connector: c })}
              >
                Connect wallet
              </button>
            ))}
          {isConnected && (
            <div className="font-mono text-[12px] text-ink-muted">{short(address!)}</div>
          )}
        </div>
      </header>

      {chainError && (
        <p className="mt-8 border-l-2 border-danger py-2 pl-4 font-mono text-[13px] text-danger">
          {chainError}
        </p>
      )}

      {stream && meta && (
        <>
          {/* ── Always public ─────────────────────────────────────────────── */}
          <section className="mt-10">
            <h2 className="label">Public record</h2>
            <dl className="mt-5 grid gap-5 sm:grid-cols-2">
              <Field label="employer">
                <Mono>{short(stream.employer)}</Mono>
              </Field>
              <Field label="recipient">
                <Mono>{short(stream.recipient)}</Mono>
              </Field>
              <Field label="funded">
                <Mono>
                  {fmt(stream.funded, 2)} {meta.symbol}
                </Mono>
              </Field>
              <Field label="withdrawn">
                <Mono>
                  {fmt(stream.withdrawn)} {meta.symbol}
                </Mono>
              </Field>
            </dl>
          </section>

          {/* ── Gated ────────────────────────────────────────────────────── */}
          <section className="mt-10 border-t border-rule pt-6">
            <h2 className="label">Your terms</h2>

            {!terms && (
              <div className="mt-5">
                <p className="max-w-xl text-[14px] leading-relaxed text-ink-muted">
                  The rate is sealed to the enclave — not even you can decrypt it
                  locally. Sign a challenge to prove you are a party to this
                  stream, and the enclave will return your terms along with a
                  withdrawal authorization.
                </p>
                <button
                  type="button"
                  disabled={!isConnected || !isParty || busy || !sealed}
                  onClick={() => void unlock()}
                  className="mt-5 border border-rule px-4 py-2 font-mono text-[13px] enabled:hover:border-accent enabled:hover:text-accent disabled:cursor-not-allowed disabled:text-ink-subtle"
                >
                  {busy ? "working…" : "Sign to unlock"}
                </button>

                {isConnected && !isParty && (
                  <p className="mt-3 font-mono text-[12px] text-warn">
                    This wallet is neither the employer nor the recipient. The
                    enclave will refuse — that is the point.
                  </p>
                )}
                {!sealed && !chainError && (
                  <p className="mt-3 font-mono text-[12px] text-ink-subtle">
                    locating sealed terms…
                  </p>
                )}
              </div>
            )}

            {terms && (
              <dl className="mt-5 grid gap-5 sm:grid-cols-2">
                <Field label="rate">
                  <Mono>
                    {perDay} {meta.symbol}/day
                  </Mono>
                </Field>
                <Field label="accrued">
                  <span className="font-mono text-2xl tabular-nums tracking-tight text-accent">
                    {fmt(accrued)}
                  </span>{" "}
                  <span className="font-mono text-[12px] text-ink-subtle">
                    {meta.symbol}
                  </span>
                </Field>
                <Field label="available now">
                  <Mono>
                    {fmt(available)} {meta.symbol}
                  </Mono>
                </Field>
                <Field label="total cap">
                  <Mono>
                    {fmt(terms.total, 2)} {meta.symbol}
                  </Mono>
                </Field>
              </dl>
            )}
          </section>

          {/* ── Withdraw ─────────────────────────────────────────────────── */}
          {terms && (
            <section className="mt-10 border-t border-rule-2 pt-6">
              <h2 className="label">Withdraw</h2>
              <p className="mt-4 max-w-xl text-[13px] leading-relaxed text-ink-muted">
                The enclave signed for{" "}
                <span className="font-mono">
                  {fmt(auth ? BigInt(auth.cumulativeAccrued) : null)} {meta.symbol}
                </span>{" "}
                cumulative. The vault pays the difference against what you have
                already taken, so replaying this authorization is harmless.
              </p>
              <button
                type="button"
                disabled={!auth || busy || (available ?? 0n) <= 0n}
                onClick={() => void withdraw()}
                className="mt-5 border border-rule px-4 py-2 font-mono text-[13px] enabled:hover:border-accent enabled:hover:text-accent disabled:cursor-not-allowed disabled:text-ink-subtle"
              >
                {busy ? "working…" : auth ? "Withdraw" : "Sign again for a fresh authorization"}
              </button>
            </section>
          )}

          {status && (
            <p className="mt-6 border-l-2 border-accent py-2 pl-4 font-mono text-[12px] text-ink-muted">
              {status}
            </p>
          )}

          {/* Explicit, not a spinner — this is the screen a dead tunnel breaks. */}
          {failure && (
            <div className="mt-6 border-l-2 border-danger py-3 pl-4">
              <p className="font-mono text-[13px] text-danger">
                {failure.kind === "unreachable"
                  ? "The confidential compute extension is unreachable."
                  : "The enclave refused this request."}
              </p>
              <p className="mt-1 font-mono text-[11px] text-ink-muted">{failure.detail}</p>
              {failure.kind === "unreachable" && (
                <p className="mt-2 max-w-xl text-[13px] leading-relaxed text-ink-muted">
                  Withdrawals need the enclave; the rest of StealthWage does not.
                  The{" "}
                  <a className="text-accent underline decoration-rule-2 underline-offset-4" href="/">
                    landing page
                  </a>{" "}
                  and{" "}
                  <a
                    className="text-accent underline decoration-rule-2 underline-offset-4"
                    href={`/verify/${params.id}`}
                  >
                    audit record
                  </a>{" "}
                  read only from the chain and are unaffected.
                  <span className="mt-1 block font-mono text-[11px] text-ink-subtle">
                    endpoint: {ENCLAVE_URL}
                  </span>
                </p>
              )}
            </div>
          )}

          {withdrawTx && (
            <p className="mt-6 border-l-2 border-success py-3 pl-4 font-mono text-[13px] text-success">
              Withdrawal confirmed.{" "}
              <a
                className="text-accent underline decoration-rule-2 underline-offset-4"
                href={`${EXPLORER}/tx/${withdrawTx}`}
                target="_blank"
                rel="noreferrer"
              >
                view transaction
              </a>
            </p>
          )}
        </>
      )}

      <footer className="mt-14 border-t-2 border-rule pt-5 font-mono text-[11px] text-ink-subtle">
        <a className="text-accent underline decoration-rule-2 underline-offset-4" href="/">
          ← StealthWage
        </a>{" "}
        · <a className="text-accent underline decoration-rule-2 underline-offset-4" href={`/verify/${params.id}`}>audit record</a>{" "}
        · Coston2
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

const Mono = ({ children }: { children: React.ReactNode }) => (
  <span className="font-mono text-[13px] tabular-nums">{children}</span>
);
