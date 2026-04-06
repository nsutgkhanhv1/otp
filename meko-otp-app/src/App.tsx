import { useEffect, useRef, useState } from "react";

const API_BASE = "https://meko-otp.phancongjp.workers.dev";

type ListenStatus = "idle" | "waiting" | "received";

type OtpResponse = {
  email: string;
  otp: string | null;
  receivedAt: number | null;
};

export default function App() {
  const [email, setEmail] = useState("");
  const [otp, setOtp] = useState<string | null>(null);
  const [status, setStatus] = useState<ListenStatus>("idle");

  const intervalRef = useRef<number | null>(null);
  const sessionRef = useRef(0);

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
    const trimmedEmail = email.trim();
    if (!trimmedEmail) {
      return;
    }

    const sessionId = sessionRef.current + 1;
    sessionRef.current = sessionId;

    setOtp(null);
    setStatus("waiting");
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
    const trimmedEmail = email.trim();
    if (!trimmedEmail) {
      return;
    }

    sessionRef.current += 1;
    stopPolling();

    try {
      await clearOtpOnServer(trimmedEmail);
    } catch (err) {
      console.error("Failed to clear OTP", err);
    }

    setOtp(null);
    setStatus("idle");
  };

  const copyOtp = async () => {
    if (otp) {
      await navigator.clipboard.writeText(otp);
      alert("Copied OTP!");
    }
  };

  useEffect(() => {
    return () => {
      stopPolling();
    };
  }, []);

  return (
    <div style={styles.container}>
      <h1>OTP Listener</h1>

      <input
        style={styles.input}
        placeholder="Enter email (e.g. test@domain.com)"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
      />

      <div style={styles.buttonRow}>
        <button style={styles.button} onClick={() => void startListening()}>
          Start Listening
        </button>

        <button style={styles.buttonSecondary} onClick={() => void reset()}>
          Reset
        </button>
      </div>

      <div style={styles.status}>
        {status === "idle" && "Idle"}
        {status === "waiting" && "Waiting for a new OTP..."}
        {status === "received" && "OTP received"}
      </div>

      {otp && (
        <div style={styles.otpBox}>
          <div style={styles.otp}>{otp}</div>
          <button style={styles.copyBtn} onClick={() => void copyOtp()}>
            Copy
          </button>
        </div>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    maxWidth: 400,
    margin: "100px auto",
    fontFamily: "sans-serif",
    textAlign: "center",
  },
  input: {
    width: "100%",
    padding: "10px",
    marginBottom: "12px",
    fontSize: "16px",
  },
  buttonRow: {
    display: "flex",
    gap: "10px",
    justifyContent: "center",
  },
  button: {
    padding: "10px 16px",
    cursor: "pointer",
  },
  buttonSecondary: {
    padding: "10px 16px",
    cursor: "pointer",
    background: "#eee",
  },
  status: {
    marginTop: "20px",
    fontSize: "14px",
  },
  otpBox: {
    marginTop: "20px",
  },
  otp: {
    fontSize: "32px",
    fontWeight: "bold",
    marginBottom: "10px",
  },
  copyBtn: {
    padding: "6px 12px",
    cursor: "pointer",
  },
};
