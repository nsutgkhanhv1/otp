import { useEffect, useRef, useState } from "react";

const API_BASE = import.meta.env.VITE_OTP_API_BASE ?? "http://localhost:8787";
const POLL_INTERVAL_MS = 2000;

type ListenStatus = "idle" | "waiting" | "received";

type OtpResponse = {
  sessionId: string | null;
  sessionStatus: "waiting" | "resolved" | "expired";
  email: string;
  otp: string | null;
  receivedAt: number | null;
  matchedBy?: "recipient" | null;
  error: string | null;
  debug: Record<string, unknown> | null;
};

type CreateSessionResponse = {
  sessionId: string;
  email: string;
  startedAt: number;
  effectiveSince: number;
};

const statusCopy: Record<ListenStatus, { label: string; detail: string }> = {
  idle: {
    label: "San sang",
    detail: "Nhap email ban muon nhan ma roi bam bat dau.",
  },
  waiting: {
    label: "Dang cho ma",
    detail: "Hay gui ma ve email nay. Neu da gui ma ma chua thay, bam Lam moi.",
  },
  received: {
    label: "Da co ma",
    detail: "Ma xac minh moi da san sang de sao chep.",
  },
};

export default function App() {
  const [email, setEmail] = useState("");
  const [otp, setOtp] = useState<string | null>(null);
  const [status, setStatus] = useState<ListenStatus>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [hasCopied, setHasCopied] = useState(false);
  const [debugInfo, setDebugInfo] = useState<Record<string, unknown> | null>(null);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);

  const timeoutRef = useRef<number | null>(null);
  const sessionRef = useRef(0);
  const activeSessionIdRef = useRef<string | null>(null);
  const trimmedEmail = email.trim();
  const canListen = trimmedEmail.length > 0;

  const setSessionState = (sessionId: string | null) => {
    activeSessionIdRef.current = sessionId;
    setActiveSessionId(sessionId);
  };

  const stopPolling = () => {
    if (timeoutRef.current !== null) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
  };

  const clearOtpOnServer = async (sessionId: string | null) => {
    if (!sessionId) {
      return;
    }

    await fetch(`${API_BASE}/clear`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId }),
    });
  };

  const createSessionOnServer = async (targetEmail: string) => {
    const res = await fetch(`${API_BASE}/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: targetEmail }),
    });

    const data = (await res.json()) as Partial<CreateSessionResponse> & { error?: string };

    if (!res.ok || !data.sessionId) {
      throw new Error(data.error ?? "Khong tao duoc session moi.");
    }

    return data.sessionId;
  };

  const startListening = async () => {
    if (!trimmedEmail) {
      return;
    }

    const runId = sessionRef.current + 1;
    sessionRef.current = runId;

    const previousSessionId = activeSessionIdRef.current;

    setOtp(null);
    setHasCopied(false);
    setStatus("waiting");
    setErrorMessage(null);
    setDebugInfo(null);
    setSessionState(null);
    stopPolling();

    try {
      await clearOtpOnServer(previousSessionId);
    } catch (err) {
      console.error("Failed to clear previous session", err);
    }

    let newSessionId: string;

    try {
      newSessionId = await createSessionOnServer(trimmedEmail);
    } catch (err) {
      console.error("Failed to create OTP session", err);
      setStatus("idle");
      setErrorMessage("Khong tao duoc session lay OTP. Kiem tra backend va thu lai.");
      return;
    }

    if (sessionRef.current !== runId) {
      try {
        await clearOtpOnServer(newSessionId);
      } catch (err) {
        console.error("Failed to clear abandoned session", err);
      }
      return;
    }

    setSessionState(newSessionId);

    let hasReceivedOtp = false;

    const pollOtp = async (): Promise<boolean> => {
      try {
        const res = await fetch(`${API_BASE}/otp?sessionId=${encodeURIComponent(newSessionId)}`);
        if (!res.ok) {
          setErrorMessage(`API OTP dang loi (${res.status}). Dang thu lai...`);
          return sessionRef.current === runId;
        }

        const data = (await res.json()) as OtpResponse;
        setDebugInfo(data.debug ?? null);

        if (sessionRef.current !== runId) {
          return false;
        }

        if (data.sessionStatus === "expired") {
          stopPolling();
          setSessionState(null);
          setStatus("idle");
          setErrorMessage(data.error ?? "Session da het han. Hay bat dau lai.");
          return false;
        }

        setErrorMessage(data.error);

        if (data.otp) {
          hasReceivedOtp = true;
          setOtp(data.otp);
          setStatus("received");
          stopPolling();
          return false;
        }

        return true;
      } catch (err) {
        console.error("Failed to fetch OTP", err);
        setErrorMessage("Khong goi duoc API OTP. Kiem tra backend va mang.");
        return sessionRef.current === runId;
      }
    };

    const scheduleNextPoll = () => {
      timeoutRef.current = window.setTimeout(async () => {
        timeoutRef.current = null;
        const shouldContinue = await pollOtp();

        if (sessionRef.current === runId && shouldContinue) {
          scheduleNextPoll();
        }
      }, POLL_INTERVAL_MS);
    };

    const shouldContinue = await pollOtp();

    if (sessionRef.current !== runId || hasReceivedOtp || !shouldContinue) {
      return;
    }

    scheduleNextPoll();
  };

  const reset = async () => {
    sessionRef.current += 1;
    stopPolling();

    try {
      await clearOtpOnServer(activeSessionIdRef.current);
    } catch (err) {
      console.error("Failed to clear OTP session", err);
      setErrorMessage("Chua lam moi duoc. Vui long thu lai sau it giay.");
    }

    setSessionState(null);
    setOtp(null);
    setHasCopied(false);
    setStatus("idle");
    setDebugInfo(null);
  };

  const copyOtp = async () => {
    if (!otp) {
      return;
    }

    await navigator.clipboard.writeText(otp);
    setHasCopied(true);
    window.setTimeout(() => setHasCopied(false), 1600);
  };

  useEffect(() => {
    return () => {
      stopPolling();
    };
  }, []);

  return (
    <main className="app-shell">
      <section className="hero-panel" aria-label="Meko lay ma xac minh">
        <div className="brand-row">
          <img className="brand-mark" src="/favicon.ico" alt="" />
          <span className="eyebrow">Meko lay ma xac minh</span>
        </div>

        <div className="hero-grid">
          <div className="intro">
            <p className="kicker">Lay ma tu email</p>
            <h1 id="app-title">Nhan ma xac minh nhanh va de sao chep.</h1>
            <p className="lede">
              Nhap email, bam bat dau, roi gui ma ve email do. Khi co ma moi, ban chi can
              bam sao chep.
            </p>
          </div>

          <form
            className="listener-card"
            onSubmit={(event) => {
              event.preventDefault();
              void startListening();
            }}
          >
            <div className="card-heading">
              <div>
                <p className="section-label">Email nhan ma</p>
                <h2>Ban muon lay ma tu email nao?</h2>
              </div>
              <span className={`status-pill status-pill--${status}`}>
                <span className="status-dot" />
                {statusCopy[status].label}
              </span>
            </div>

            <label className="email-field">
              <span>Dia chi email</span>
              <input
                placeholder="vidu@email.com"
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
            </label>

            <div className="button-row">
              <button className="primary-button" disabled={!canListen} type="submit">
                {status === "waiting" ? "Dang cho ma..." : "Bat dau lay ma"}
              </button>
              <button
                className="secondary-button"
                disabled={!activeSessionId && !otp && status === "idle"}
                onClick={() => void reset()}
                type="button"
              >
                Lam moi
              </button>
            </div>

            <div className={`status-card status-card--${status}`} role="status">
              <div className="status-icon" aria-hidden="true">
                {status === "received" ? "OK" : status === "waiting" ? "..." : "-"}
              </div>
              <div>
                <strong>{statusCopy[status].label}</strong>
                <p>{statusCopy[status].detail}</p>
              </div>
            </div>

            {errorMessage && <div className="error-banner">{errorMessage}</div>}

            <div className={`otp-panel ${otp ? "otp-panel--ready" : ""}`}>
              <p className="section-label">Ma xac minh moi nhat</p>
              <div className="otp-row">
                <div className="otp-code" aria-live="polite">
                  {otp ?? "------"}
                </div>
                <button
                  className="copy-button"
                  disabled={!otp}
                  onClick={() => void copyOtp()}
                  type="button"
                >
                  {hasCopied ? "Da sao chep" : "Sao chep"}
                </button>
              </div>
            </div>

            <div className="debug-panel">
              <div className="debug-heading">
                <p className="section-label">Debug response</p>
                <strong>Payload tra ve tu backend</strong>
              </div>
              <pre className="debug-output">{JSON.stringify(debugInfo, null, 2) ?? "null"}</pre>
            </div>
          </form>
        </div>
      </section>
    </main>
  );
}
