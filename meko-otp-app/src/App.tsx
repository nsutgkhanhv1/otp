import { useEffect, useRef, useState } from "react";

const API_BASE = import.meta.env.VITE_OTP_API_BASE ?? "http://localhost:8787";
const POLL_INTERVAL_MS = 2000;

type ListenStatus = "idle" | "waiting" | "received";
type Language = "vi" | "en";

type OtpResponse = {
  sessionId: string | null;
  sessionStatus: "waiting" | "resolved" | "expired";
  email: string;
  otp: string | null;
  receivedAt: number | null;
  matchedBy?: "recipient" | null;
  error: string | null;
};

type CreateSessionResponse = {
  sessionId: string;
  email: string;
  startedAt: number;
  effectiveSince: number;
};

const copy = {
  vi: {
    brand: "Meko nhận mã xác minh",
    heroAria: "Meko nhận mã xác minh",
    languageLabel: "Ngôn ngữ",
    languageOptions: {
      vi: "Tiếng Việt",
      en: "English",
    },
    kicker: "Mã xác minh qua email",
    title: "Nhận mã nhanh, sao chép gọn.",
    lede:
      "Nhập email cần nhận mã, bấm bắt đầu rồi gửi mã về địa chỉ đó. Khi có mã mới, bạn chỉ cần sao chép.",
    formLabel: "Email cần nhận mã",
    formTitle: "Bạn muốn lấy mã từ email nào?",
    emailLabel: "Địa chỉ email",
    emailPlaceholder: "vidu@email.com",
    startButton: "Bắt đầu nhận mã",
    waitingButton: "Đang chờ mã...",
    refreshButton: "Làm mới",
    otpLabel: "Mã xác minh mới nhất",
    copyButton: "Sao chép",
    copiedButton: "Đã sao chép",
    statusIcon: {
      idle: "-",
      waiting: "...",
      received: "OK",
    },
    status: {
      idle: {
        label: "Sẵn sàng",
        detail: "Nhập email cần nhận mã rồi bấm bắt đầu.",
      },
      waiting: {
        label: "Đang chờ mã",
        detail: "Hãy gửi mã về email này. Nếu đã gửi mà chưa thấy mã, bấm Làm mới.",
      },
      received: {
        label: "Đã có mã",
        detail: "Mã xác minh mới đã sẵn sàng để sao chép.",
      },
    },
    errors: {
      sessionCreateFallback: "Không thể bắt đầu phiên nhận mã mới.",
      sessionCreateFailed: "Không thể bắt đầu nhận mã. Vui lòng kiểm tra kết nối rồi thử lại.",
      otpApiRetry: (statusCode: number) => `Chưa lấy được mã (${statusCode}). Hệ thống đang thử lại...`,
      sessionExpired: "Phiên nhận mã đã hết hạn. Vui lòng bắt đầu lại.",
      otpFetchFailed: "Không thể kiểm tra mã mới. Vui lòng kiểm tra kết nối mạng.",
      refreshFailed: "Chưa thể làm mới. Vui lòng thử lại sau vài giây.",
    },
  },
  en: {
    brand: "Meko verification codes",
    heroAria: "Meko verification code receiver",
    languageLabel: "Language",
    languageOptions: {
      vi: "Tiếng Việt",
      en: "English",
    },
    kicker: "Email verification codes",
    title: "Receive codes fast. Copy them cleanly.",
    lede:
      "Enter the email that should receive the code, start listening, then send the code to that address. When a new code arrives, copy it in one click.",
    formLabel: "Email to watch",
    formTitle: "Which email should we watch?",
    emailLabel: "Email address",
    emailPlaceholder: "example@email.com",
    startButton: "Start receiving codes",
    waitingButton: "Waiting for code...",
    refreshButton: "Refresh",
    otpLabel: "Latest verification code",
    copyButton: "Copy",
    copiedButton: "Copied",
    statusIcon: {
      idle: "-",
      waiting: "...",
      received: "OK",
    },
    status: {
      idle: {
        label: "Ready",
        detail: "Enter the email that will receive the code, then start listening.",
      },
      waiting: {
        label: "Waiting",
        detail: "Send the code to this email. If it was already sent, try Refresh.",
      },
      received: {
        label: "Code received",
        detail: "A new verification code is ready to copy.",
      },
    },
    errors: {
      sessionCreateFallback: "Could not start a new receiving session.",
      sessionCreateFailed: "Could not start receiving codes. Check the connection and try again.",
      otpApiRetry: (statusCode: number) => `No code yet (${statusCode}). Retrying...`,
      sessionExpired: "The session expired. Please start again.",
      otpFetchFailed: "Could not check for a new code. Please check the network connection.",
      refreshFailed: "Could not refresh yet. Please try again in a few seconds.",
    },
  },
} satisfies Record<
  Language,
  {
    brand: string;
    heroAria: string;
    languageLabel: string;
    languageOptions: Record<Language, string>;
    kicker: string;
    title: string;
    lede: string;
    formLabel: string;
    formTitle: string;
    emailLabel: string;
    emailPlaceholder: string;
    startButton: string;
    waitingButton: string;
    refreshButton: string;
    otpLabel: string;
    copyButton: string;
    copiedButton: string;
    statusIcon: Record<ListenStatus, string>;
    status: Record<ListenStatus, { label: string; detail: string }>;
    errors: {
      sessionCreateFallback: string;
      sessionCreateFailed: string;
      otpApiRetry: (statusCode: number) => string;
      sessionExpired: string;
      otpFetchFailed: string;
      refreshFailed: string;
    };
  }
>;

const getInitialLanguage = (): Language => {
  if (typeof window === "undefined") {
    return "vi";
  }

  return window.localStorage.getItem("meko-language") === "en" ? "en" : "vi";
};

const getInitialEmail = (): string => {
  if (typeof window === "undefined") {
    return "";
  }

  const path = window.location.pathname.replace(/^\/+|\/+$/g, "");

  if (!path || path.includes("/")) {
    return "";
  }

  try {
    const emailFromPath = decodeURIComponent(path).trim();

    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailFromPath) ? emailFromPath : "";
  } catch {
    return "";
  }
};

export default function App() {
  const [language, setLanguage] = useState<Language>(getInitialLanguage);
  const [email, setEmail] = useState(getInitialEmail);

  const [otp, setOtp] = useState<string | null>(null);
  const [status, setStatus] = useState<ListenStatus>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [hasCopied, setHasCopied] = useState(false);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);

  const timeoutRef = useRef<number | null>(null);
  const sessionRef = useRef(0);
  const activeSessionIdRef = useRef<string | null>(null);
  const trimmedEmail = email.trim();
  const canListen = trimmedEmail.length > 0;
  const t = copy[language];

  const changeLanguage = (nextLanguage: Language) => {
    setLanguage(nextLanguage);
    window.localStorage.setItem("meko-language", nextLanguage);
  };

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
      throw new Error(data.error ?? t.errors.sessionCreateFallback);
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
      setErrorMessage(t.errors.sessionCreateFailed);
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
          setErrorMessage(t.errors.otpApiRetry(res.status));
          return sessionRef.current === runId;
        }

        const data = (await res.json()) as OtpResponse;

        if (sessionRef.current !== runId) {
          return false;
        }

        if (data.sessionStatus === "expired") {
          stopPolling();
          setSessionState(null);
          setStatus("idle");
          setErrorMessage(data.error ?? t.errors.sessionExpired);
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
        setErrorMessage(t.errors.otpFetchFailed);
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
      setErrorMessage(t.errors.refreshFailed);
    }

    setSessionState(null);
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
      <section className="hero-panel" aria-label={t.heroAria}>
        <div className="brand-row">
          <div className="brand-lockup">
            <img className="brand-mark" src="/favicon.ico" alt="" />
            <span className="eyebrow">{t.brand}</span>
          </div>

          <label className="language-select">
            <span>{t.languageLabel}</span>
            <select
              aria-label={t.languageLabel}
              value={language}
              onChange={(event) => changeLanguage(event.target.value as Language)}
            >
              <option value="vi">{t.languageOptions.vi}</option>
              <option value="en">{t.languageOptions.en}</option>
            </select>
          </label>
        </div>

        <div className="hero-grid">
          <div className="intro">
            <p className="kicker">{t.kicker}</p>
            <h1 id="app-title">{t.title}</h1>
            <p className="lede">{t.lede}</p>
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
                <p className="section-label">{t.formLabel}</p>
                <h2>{t.formTitle}</h2>
              </div>
              <span className={`status-pill status-pill--${status}`}>
                <span className="status-dot" />
                {t.status[status].label}
              </span>
            </div>

            <label className="email-field">
              <span>{t.emailLabel}</span>
              <input
                placeholder={t.emailPlaceholder}
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
            </label>

            <div className="button-row">
              <button className="primary-button" disabled={!canListen} type="submit">
                {status === "waiting" ? t.waitingButton : t.startButton}
              </button>
              <button
                className="secondary-button"
                disabled={!activeSessionId && !otp && status === "idle"}
                onClick={() => void reset()}
                type="button"
              >
                {t.refreshButton}
              </button>
            </div>

            <div className={`status-card status-card--${status}`} role="status">
              <div className="status-icon" aria-hidden="true">
                {t.statusIcon[status]}
              </div>
              <div>
                <strong>{t.status[status].label}</strong>
                <p>{t.status[status].detail}</p>
              </div>
            </div>

            {errorMessage && <div className="error-banner">{errorMessage}</div>}

            <div className={`otp-panel ${otp ? "otp-panel--ready" : ""}`}>
              <p className="section-label">{t.otpLabel}</p>
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
                  {hasCopied ? t.copiedButton : t.copyButton}
                </button>
              </div>
            </div>
          </form>
        </div>
      </section>
    </main>
  );
}
