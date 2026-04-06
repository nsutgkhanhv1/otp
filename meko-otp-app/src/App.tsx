import { useState, useRef } from "react";

const API_BASE = "https://meko-otp.phancongjp.workers.dev"; // <-- sửa lại

export default function App() {
  const [email, setEmail] = useState("");
  const [otp, setOtp] = useState<string | null>(null);
  const [status, setStatus] = useState<"idle" | "waiting" | "received">("idle");

  const intervalRef = useRef<number | null>(null);

  const startListening = () => {
    if (!email) return;

    setOtp(null);
    setStatus("waiting");

    // clear interval cũ nếu có
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
    }

    intervalRef.current = window.setInterval(async () => {
      try {
        const res = await fetch(
          `${API_BASE}/otp?email=${encodeURIComponent(email)}`,
        );
        const data = await res.json();

        if (data.otp) {
          setOtp(data.otp);
          setStatus("received");

          // stop polling
          if (intervalRef.current) {
            clearInterval(intervalRef.current);
          }
        }
      } catch (err) {
        console.error(err);
      }
    }, 2000);
  };

  const reset = async () => {
    if (!email) return;

    await fetch(`${API_BASE}/clear`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    });

    setOtp(null);
    setStatus("idle");

    if (intervalRef.current) {
      clearInterval(intervalRef.current);
    }
  };

  const copyOtp = async () => {
    if (otp) {
      await navigator.clipboard.writeText(otp);
      alert("Copied OTP!");
    }
  };

  return (
    <div style={styles.container}>
      <h1>📩 OTP Listener</h1>

      <input
        style={styles.input}
        placeholder="Enter email (e.g. test@domain.com)"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
      />

      <div style={styles.buttonRow}>
        <button style={styles.button} onClick={startListening}>
          Start Listening
        </button>

        <button style={styles.buttonSecondary} onClick={reset}>
          Reset
        </button>
      </div>

      <div style={styles.status}>
        {status === "idle" && "Idle"}
        {status === "waiting" && "⏳ Waiting for OTP..."}
        {status === "received" && "✅ OTP Received"}
      </div>

      {otp && (
        <div style={styles.otpBox}>
          <div style={styles.otp}>{otp}</div>
          <button style={styles.copyBtn} onClick={copyOtp}>
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
