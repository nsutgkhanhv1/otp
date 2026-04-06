import "dotenv/config";
import { createServer, IncomingMessage, ServerResponse } from "node:http";
import process from "node:process";
import { ImapFlow, ImapFlowOptions, FetchMessageObject } from "imapflow";

type EnvConfig = {
  port: number;
  host: string;
  mailbox: string;
  secure: boolean;
  user: string;
  pass: string;
  lookbackMinutes: number;
  fetchLimit: number;
};

type OtpResult = {
  email: string;
  otp: string | null;
  receivedAt: number | null;
  matchedBy: "email" | "fallback" | null;
};

type MailCandidate = {
  uid: number;
  source: string;
  receivedAt: number;
};

const config = loadConfig();

async function handleRequest(req: IncomingMessage, res: ServerResponse) {
  setCorsHeaders(res);

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

  if (req.method === "GET" && url.pathname === "/") {
    sendJson(res, 200, {
      status: "ok",
      mode: "imap-source",
      mailbox: config.mailbox,
      host: config.host,
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/otp") {
    const email = url.searchParams.get("email")?.trim() ?? "";
    const since = parseSince(url.searchParams.get("since"));

    const result = await imapService.findOtp(email, since);
    sendJson(res, 200, result);
    return;
  }

  if (req.method === "POST" && url.pathname === "/clear") {
    sendJson(res, 200, { success: true });
    return;
  }

  sendJson(res, 404, { error: "Not found" });
}

function setCorsHeaders(res: ServerResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Content-Type", "application/json; charset=utf-8");
}

function sendJson(res: ServerResponse, statusCode: number, payload: unknown) {
  res.statusCode = statusCode;
  res.end(JSON.stringify(payload));
}

function parseSince(value: string | null): number {
  if (!value) {
    return Date.now() - config.lookbackMinutes * 60_000;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return Date.now() - config.lookbackMinutes * 60_000;
  }

  return parsed;
}

function loadConfig(): EnvConfig {
  const port = Number.parseInt(process.env.PORT ?? "8787", 10);
  const host = requireEnv("OTP_SOURCE_HOST");
  const mailbox = process.env.OTP_SOURCE_MAILBOX?.trim() || "INBOX";
  const user = requireEnv("OTP_SOURCE_USER");
  const pass = requireEnv("OTP_SOURCE_PASS");
  const secure = parseBoolean(process.env.OTP_SOURCE_SECURE, true);
  const lookbackMinutes = parsePositiveInt(process.env.OTP_LOOKBACK_MINUTES, 15);
  const fetchLimit = parsePositiveInt(process.env.OTP_FETCH_LIMIT, 30);

  return {
    port: Number.isFinite(port) ? port : 8787,
    host,
    mailbox,
    secure,
    user,
    pass,
    lookbackMinutes,
    fetchLimit,
  };
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (!value) {
    return fallback;
  }

  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }

  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }

  return fallback;
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function createImapConfig(env: EnvConfig): ImapFlowOptions {
  return {
    host: env.host,
    port: env.secure ? 993 : 143,
    secure: env.secure,
    auth: {
      user: env.user,
      pass: env.pass,
    },
    logger: false,
  };
}

class ImapService {
  private client: ImapFlow | null = null;
  private connectPromise: Promise<ImapFlow> | null = null;

  constructor(private readonly env: EnvConfig) {}

  async findOtp(email: string, since: number): Promise<OtpResult> {
    const normalizedEmail = email.toLowerCase();
    const candidates = await this.fetchCandidates(since);

    const emailMatch = candidates.find((candidate) => {
      return matchesEmail(candidate.source, normalizedEmail) && extractOtp(candidate.source);
    });

    if (emailMatch) {
      return {
        email,
        otp: extractOtp(emailMatch.source),
        receivedAt: emailMatch.receivedAt,
        matchedBy: "email",
      };
    }

    const fallbackMatch = candidates.find((candidate) => extractOtp(candidate.source));
    if (fallbackMatch) {
      return {
        email,
        otp: extractOtp(fallbackMatch.source),
        receivedAt: fallbackMatch.receivedAt,
        matchedBy: normalizedEmail ? "fallback" : "email",
      };
    }

    return {
      email,
      otp: null,
      receivedAt: null,
      matchedBy: null,
    };
  }

  async close() {
    this.connectPromise = null;

    if (!this.client) {
      return;
    }

    const currentClient = this.client;
    this.client = null;

    if (currentClient.usable) {
      await currentClient.logout();
      return;
    }

    currentClient.close();
  }

  private async fetchCandidates(since: number): Promise<MailCandidate[]> {
    const client = await this.getClient();
    const lock = await client.getMailboxLock(this.env.mailbox);

    try {
      const searchSince = new Date(since - this.env.lookbackMinutes * 60_000);
      const uids = (await client.search({ since: searchSince }, { uid: true })) || [];

      if (uids.length === 0) {
        return [];
      }

      const recentUids = uids.slice(-this.env.fetchLimit);
      const messages = await client.fetchAll(
        recentUids,
        {
          envelope: true,
          internalDate: true,
          source: true,
        },
        { uid: true },
      );

      return messages
        .map((message) => toMailCandidate(message))
        .filter((message): message is MailCandidate => Boolean(message))
        .filter((message) => message.receivedAt >= since)
        .sort((a, b) => b.receivedAt - a.receivedAt || b.uid - a.uid);
    } finally {
      lock.release();
    }
  }

  private async getClient(): Promise<ImapFlow> {
    if (this.client?.usable) {
      return this.client;
    }

    if (this.connectPromise) {
      return this.connectPromise;
    }

    this.connectPromise = (async () => {
      const client = new ImapFlow(createImapConfig(this.env));

      client.on("close", () => {
        this.client = null;
      });

      client.on("error", (error) => {
        console.error("IMAP connection error:", error);
      });

      await client.connect();
      this.client = client;
      this.connectPromise = null;
      return client;
    })();

    try {
      return await this.connectPromise;
    } catch (error) {
      this.connectPromise = null;
      this.client = null;
      throw error;
    }
  }
}

const imapService = new ImapService(config);

const server = createServer(async (req, res) => {
  try {
    await handleRequest(req, res);
  } catch (error) {
    console.error("Unhandled server error:", error);
    sendJson(res, 500, { error: "Internal server error" });
  }
});

server.listen(config.port, () => {
  console.log(`OTP server is listening on http://localhost:${config.port}`);
});

process.on("SIGINT", async () => {
  await shutdown("SIGINT");
});

process.on("SIGTERM", async () => {
  await shutdown("SIGTERM");
});

async function shutdown(signal: string) {
  console.log(`Received ${signal}, shutting down...`);
  server.close();
  await imapService.close();
  process.exit(0);
}

function toMailCandidate(message: FetchMessageObject): MailCandidate | null {
  if (!message.source || !message.internalDate) {
    return null;
  }

  return {
    uid: message.uid,
    source: message.source.toString("utf8"),
    receivedAt: new Date(message.internalDate).getTime(),
  };
}

function matchesEmail(source: string, email: string): boolean {
  if (!email) {
    return true;
  }

  return source.toLowerCase().includes(email);
}

function extractOtp(text: string): string | null {
  const keywordPatterns = [
    /otp[^0-9]{0,20}([0-9]{4,8})/i,
    /code[^0-9]{0,20}([0-9]{4,8})/i,
    /verification[^0-9]{0,20}([0-9]{4,8})/i,
    /password[^0-9]{0,20}([0-9]{4,8})/i,
  ];

  for (const pattern of keywordPatterns) {
    const match = text.match(pattern);
    if (match?.[1]) {
      return match[1];
    }
  }

  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    const clean = line.trim();
    if (/^\d{4,8}$/.test(clean)) {
      return clean;
    }
  }

  const matches = text.match(/\b\d{4,8}\b/g) || [];
  const filtered = matches.filter((value) => {
    const parsed = Number.parseInt(value, 10);
    return !(parsed >= 1900 && parsed <= 2099);
  });

  return filtered.pop() || null;
}
