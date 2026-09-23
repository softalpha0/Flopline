import { useState } from "react";
import { burnerAccount } from "./chain";
import { createPasskeyAccount, hasStoredPasskey, passkeysSupported, signInWithPasskey, type Session } from "./mera";

export function SignIn({ onSession }: { onSession: (s: Session) => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  const returning = hasStoredPasskey();

  async function run(fn: () => Promise<Session>) {
    setBusy(true);
    setErr(undefined);
    try {
      onSession(await fn());
    } catch (e) {
      const x = e as { message?: string; name?: string };
      setErr(
        x.name === "NotAllowedError"
          ? "The passkey prompt was cancelled or timed out."
          : (x.message ?? "Sign-in failed"),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="app">
      <header className="top">
        <h1>Flopline</h1>
        <span className="tag">Testnet</span>
      </header>
      <section className="card">
        <h2>Trade GPU compute</h2>
        <p className="muted">
          Lock in next week's GPU-hour price, or sell capacity ahead of time. Sign in with a passkey: no seed phrase and
          no wallet extension.
        </p>
        {passkeysSupported() ? (
          <>
            {returning ? (
              <button className="cta buy" disabled={busy} onClick={() => run(signInWithPasskey)}>
                {busy ? "Waiting for passkey..." : "Sign in with passkey"}
              </button>
            ) : (
              <button className="cta buy" disabled={busy} onClick={() => run(() => createPasskeyAccount("Flopline account"))}>
                {busy ? "Waiting for passkey..." : "Create account with passkey"}
              </button>
            )}
            {returning && (
              <button className="cta ghost" disabled={busy} onClick={() => run(() => createPasskeyAccount("Flopline account"))}>
                Create a new account instead
              </button>
            )}
          </>
        ) : (
          <p className="warn">This browser does not support passkeys.</p>
        )}
        {err && <p className="warn">{err}</p>}
        <button
          className="cta ghost"
          onClick={() => onSession({ account: burnerAccount(), end: () => {} })}
        >
          Use a throwaway test account
        </button>
        <p className="muted small">
          Passkey accounts are derived from your device passkey and are recoverable on any device that syncs it. The
          test account lives only in this browser.
        </p>
      </section>
    </main>
  );
}
