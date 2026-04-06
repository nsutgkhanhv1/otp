import { KVNamespace } from "@cloudflare/workers-types";
import { ExecutionContext, Hono } from "hono";
import { cors } from "hono/cors";

type Bindings = {
  KV: KVNamespace;
};

const app = new Hono<{ Bindings: Bindings }>();

app.use(
  "*",
  cors({
    origin: "*", // hoặc 'http://localhost:5173'
    allowMethods: ["GET", "POST"],
    allowHeaders: ["Content-Type"],
  }),
);

/**
 * Health check
 */
app.get("/", (c) => {
  return c.text("OTP Worker is running 🚀");
});

/**
 * API: lấy OTP theo email
 * GET /otp?email=abc@domain.com
 */
app.get("/otp", async (c) => {
  const email = c.req.query("email");

  if (!email) {
    return c.json({ error: "Missing email" }, 400);
  }

  const key = `otp:${email.toLowerCase()}`;
  const otp = await c.env.KV.get(key);

  return c.json({
    email,
    otp: otp || null,
  });
});

/**
 * API: clear OTP (optional)
 */
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
  // 1. keyword
  const keywordPatterns = [
    /otp[:\s]*([0-9]{4,8})/i,
    /code[:\s]*([0-9]{4,8})/i,
    /verification[:\s]*([0-9]{4,8})/i,
  ];

  for (const pattern of keywordPatterns) {
    const match = text.match(pattern);
    if (match) return match[1];
  }

  // 2. dòng chỉ chứa số
  const lines = text.split("\n");
  for (const line of lines) {
    const clean = line.trim();
    if (/^\d{4,8}$/.test(clean)) return clean;
  }

  // 3. fallback: số cuối (lọc năm)
  const matches = text.match(/\b\d{4,8}\b/g) || [];
  const filtered = matches.filter((num) => {
    const n = parseInt(num);
    return !(n >= 1900 && n <= 2099);
  });

  return filtered.pop() || null;
}

/**
 * EXPORT Worker
 */
export default {
  fetch: app.fetch,

  /**
   * EMAIL HANDLER (Cloudflare Email Routing)
   */
  async email(message: any, env: Bindings, ctx: ExecutionContext) {
    try {
      const to = message.to?.toLowerCase();

      // Lấy nội dung email (text là tốt nhất)
      let text = "";
      try {
        text = await message.text();
      } catch {
        const raw = await new Response(message.raw).text();
        text = raw;
      }

      // 🔥 Regex bắt OTP (4-8 số)
      const otp = extractOtp(text);

      if (!otp || !to) {
        console.log("No OTP found or missing recipient");
        return;
      }

      const key = `otp:${to}`;

      // Lưu OTP vào KV (5 phút)
      await env.KV.put(key, otp, {
        expirationTtl: 300,
      });

      console.log(`Saved OTP ${otp} for ${to}`);
    } catch (err) {
      console.error("Email handler error:", err);
    }
  },
};
