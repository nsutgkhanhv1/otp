import { KVNamespace } from "@cloudflare/workers-types";
import { ExecutionContext, Hono } from "hono";
import { cors } from "hono/cors";

type Bindings = {
  KV: KVNamespace;
};

type OtpRecord = {
  otp: string;
  receivedAt: number | null;
};

const app = new Hono<{ Bindings: Bindings }>();

app.use(
  "*",
  cors({
    origin: "*",
    allowMethods: ["GET", "POST"],
    allowHeaders: ["Content-Type"],
  }),
);

app.get("/", (c) => {
  return c.text("OTP Worker is running");
});

app.get("/otp", async (c) => {
  const email = c.req.query("email");
  const sinceParam = c.req.query("since");

  if (!email) {
    return c.json({ error: "Missing email" }, 400);
  }

  const key = `otp:${email.toLowerCase()}`;
  const storedValue = await c.env.KV.get(key);
  const record = parseOtpRecord(storedValue);
  const since = sinceParam ? Number(sinceParam) : null;
  const shouldHideOtp =
    Number.isFinite(since) &&
    (!record || record.receivedAt === null || record.receivedAt <= Number(since));

  return c.json({
    email,
    otp: shouldHideOtp ? null : record?.otp ?? null,
    receivedAt: shouldHideOtp ? null : record?.receivedAt ?? null,
  });
});

app.post("/clear", async (c) => {
  const { email } = await c.req.json();

  if (!email) {
    return c.json({ error: "Missing email" }, 400);
  }

  const key = `otp:${email.toLowerCase()}`;
  await c.env.KV.delete(key);

  return c.json({ success: true });
});

function extractOtp(text: string): string | null {
  const keywordPatterns = [
    /otp[:\s]*([0-9]{4,8})/i,
    /code[:\s]*([0-9]{4,8})/i,
    /verification[:\s]*([0-9]{4,8})/i,
  ];

  for (const pattern of keywordPatterns) {
    const match = text.match(pattern);
    if (match) {
      return match[1];
    }
  }

  const lines = text.split("\n");
  for (const line of lines) {
    const clean = line.trim();
    if (/^\d{4,8}$/.test(clean)) {
      return clean;
    }
  }

  const matches = text.match(/\b\d{4,8}\b/g) || [];
  const filtered = matches.filter((num) => {
    const parsed = Number.parseInt(num, 10);
    return !(parsed >= 1900 && parsed <= 2099);
  });

  return filtered.pop() || null;
}

function parseOtpRecord(value: string | null): OtpRecord | null {
  if (!value) {
    return null;
  }

  try {
    const parsed = JSON.parse(value);
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof parsed.otp === "string" &&
      (typeof parsed.receivedAt === "number" || parsed.receivedAt === null)
    ) {
      return {
        otp: parsed.otp,
        receivedAt: parsed.receivedAt,
      };
    }
  } catch {
    // Legacy KV values may contain only the OTP string.
  }

  return {
    otp: value,
    receivedAt: null,
  };
}

async function readEmailText(message: { text?: () => Promise<string>; raw?: BodyInit | null }): Promise<string> {
  if (typeof message.text === "function") {
    try {
      const parsedText = await message.text();
      if (parsedText.trim()) {
        return parsedText;
      }
    } catch {
      // Fall back to raw body parsing below.
    }
  }

  if (message.raw) {
    return new Response(message.raw).text();
  }

  return "";
}

export default {
  fetch: app.fetch,

  async email(message: { to?: string; text?: () => Promise<string>; raw?: BodyInit }, env: Bindings, _ctx: ExecutionContext) {
    try {
      const to = message.to?.toLowerCase();

      const text = await readEmailText(message);

      const otp = extractOtp(text);

      if (!otp || !to) {
        console.log("No OTP found or missing recipient");
        return;
      }

      const key = `otp:${to}`;
      const payload: OtpRecord = {
        otp,
        receivedAt: Date.now(),
      };

      await env.KV.put(key, JSON.stringify(payload), {
        expirationTtl: 300,
      });

      console.log(`Saved OTP ${otp} for ${to}`);
    } catch (err) {
      console.error("Email handler error:", err);
    }
  },
};
