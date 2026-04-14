import { useEffect, useRef, useState } from "react";

const API_BASE = import.meta.env.VITE_OTP_API_BASE ?? "http://localhost:8787";

type ListenStatus = "idle" | "waiting" | "received";

type OtpResponse = {
  email: string;
  otp: string | null;
  receivedAt: number | null;
};

const statusCopy: Record<ListenStatus, { label: string; detail: string }> = {
  idle: {
    label: "Sẵn sàng",
    detail: "Nhập email bạn muốn nhận mã rồi bấm bắt đầu.",
  },
  waiting: {
    label: "Đang chờ mã",
    detail: "Hãy yêu cầu gửi mã về email này. Nếu đã gửi mà chưa thấy, bấm Làm mới.",
  },
  received: {
    label: "Đã có mã",
    detail: "Mã xác minh mới đã sẵn sàng để sao chép.",
  },
};

export default function App() {
  const [email, setEmail] = useState("");
  const [otp, setOtp] = useState<string | null>(null);
  const [status, setStatus] = useState<ListenStatus>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [hasCopied, setHasCopied] = useState(false);

  const intervalRef = useRef<number | null>(null);
  const sessionRef = useRef(0);
  const trimmedEmail = email.trim();
  const canListen = trimmedEmail.length > 0;

  const stopPolling = () => {
    if (intervalRef.current !== null) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  };

  const clearOtpOnServer = async (targetEmail: string) => {
    await fetch(`${API_BASE}/clear`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: targetEmail }),
    });
  };

  const startListening = async () => {
    if (!trimmedEmail) {
      return;
    }

    const sessionId = sessionRef.current + 1;
    sessionRef.current = sessionId;

    setOtp(null);
    setHasCopied(false);
    setStatus("waiting");
    setErrorMessage(null);
    stopPolling();

    const startedAt = Date.now();

    try {
      await clearOtpOnServer(trimmedEmail);
    } catch (err) {
      console.error("Failed to clear old OTP before listening", err);
    }

    if (sessionRef.current !== sessionId) {
      return;
    }

    let hasReceivedOtp = false;

    const pollOtp = async () => {
      try {
        const res = await fetch(
          `${API_BASE}/otp?email=${encodeURIComponent(trimmedEmail)}&since=${startedAt}`,
        );
        const data = (await res.json()) as OtpResponse;

        if (sessionRef.current !== sessionId) {
          return;
        }

        if (data.otp) {
          hasReceivedOtp = true;
          setOtp(data.otp);
          setStatus("received");
          setErrorMessage(null);
          stopPolling();
        }
      } catch (err) {
        console.error("Failed to fetch OTP", err);
      }
    };

    await pollOtp();

    if (sessionRef.current !== sessionId || hasReceivedOtp) {
      return;
    }

    intervalRef.current = window.setInterval(() => {
      void pollOtp();
    }, 2000);
  };

  const reset = async () => {
    if (!trimmedEmail) {
      return;
    }

    sessionRef.current += 1;
    stopPolling();

    try {
      await clearOtpOnServer(trimmedEmail);
    } catch (err) {
      console.error("Failed to clear OTP", err);
      setErrorMessage("Chưa làm mới được. Vui lòng thử lại sau ít giây.");
    }

    setOtp(null);
    setHasCopied(false);
    setStatus("idle");
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
      <section className="hero-panel" aria-labelledby="app-title">
        <div className="brand-row">
          <img className="brand-mark" src="/favicon.svg" alt="" />
          <span className="eyebrow">Meko lấy mã xác minh</span>
        </div>

        <div className="hero-grid">
          <div className="intro">
            <p className="kicker">Lấy mã từ email</p>
            <h1 id="app-title">Nhận mã xác minh nhanh và dễ sao chép.</h1>
            <p className="lede">
              Nhập email, bấm bắt đầu, rồi gửi mã về email đó. Khi có mã mới,
              bạn chỉ cần bấm sao chép.
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
                <p className="section-label">Email nhận mã</p>
                <h2>Bạn muốn lấy mã từ email nào?</h2>
              </div>
              <span className={`status-pill status-pill--${status}`}>
                <span className="status-dot" />
                {statusCopy[status].label}
              </span>
            </div>

            <label className="email-field">
              <span>Địa chỉ email</span>
              <input
                placeholder="vidu@email.com"
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
            </label>

            <div className="button-row">
              <button className="primary-button" disabled={!canListen} type="submit">
                {status === "waiting" ? "Đang chờ mã..." : "Bắt đầu lấy mã"}
              </button>
              <button
                className="secondary-button"
                disabled={!canListen}
                onClick={() => void reset()}
                type="button"
              >
                Làm mới
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
              <div>
                <p className="section-label">Mã xác minh mới nhất</p>
                <div className="otp-code" aria-live="polite">
                  {otp ?? "------"}
                </div>
              </div>
              <button
                className="copy-button"
                disabled={!otp}
                onClick={() => void copyOtp()}
                type="button"
              >
                {hasCopied ? "Đã sao chép" : "Sao chép"}
              </button>
            </div>
          </form>
        </div>
      </section>
    </main>
  );
}
