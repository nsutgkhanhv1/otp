import "dotenv/config";
import { createServer, IncomingMessage, ServerResponse } from "node:http";
import process from "node:process";
import { ImapFlow, ImapFlowOptions, FetchMessageObject } from "imapflow";
import { AddressObject, ParsedMail, simpleParser } from "mailparser";

type EnvConfig = {
  port: number;
  host: string;
  mailbox: string;
  secure: boolean;
  user: string;
  pass: string;
  lookbackMinutes: number;
  fetchLimit: number;
  sinceGraceMs: number;
};

type OtpResult = {
  email: string;
  otp: string | null;
  receivedAt: number | null;
  matchedBy: "email" | "fallback" | null;
  error: string | null;
  debug: OtpDebug;
};

type MailCandidate = {
  uid: number;
  source: Buffer;
  receivedAt: number;
};

type DebugCandidate = {
  uid: number;
  receivedAt: number;
  receivedAtIso: string;
  from: string | null;
  subject: string | null;
  otp: string | null;
  matchedEmail: boolean;
};

type OtpDebug = {
  email: string;
  normalizedEmail: string;
  host: string;
  mailbox: string;
  now: number;
  nowIso: string;
  since: number;
  sinceIso: string;
  effectiveSince: number;
  effectiveSinceIso: string;
  searchSince: number;
  searchSinceIso: string;
  lookbackMinutes: number;
  sinceGraceMs: number;
  fetchLimit: number;
  uidCount: number;
  recentUidCount: number;
  recentUids: number[];
  fetchedMessageCount: number;
  filteredMessageCount: number;
  matchedCandidateUid: number | null;
  matchedBy: "email" | "fallback" | null;
  connectionError: string | null;
  fetchError: string | null;
  candidates: DebugCandidate[];
};

type FetchCandidatesResult = {
  candidates: MailCandidate[];
  debug: OtpDebug;
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
  const port = Number.parseInt(process.env.PORT ?? "80", 10);
  const host = requireEnv("OTP_SOURCE_HOST");
  const mailbox = process.env.OTP_SOURCE_MAILBOX?.trim() || "INBOX";
  const user = requireEnv("OTP_SOURCE_USER");
  const pass = requireEnv("OTP_SOURCE_PASS");
  const secure = parseBoolean(process.env.OTP_SOURCE_SECURE, true);
  const lookbackMinutes = parsePositiveInt(process.env.OTP_LOOKBACK_MINUTES, 15);
  const fetchLimit = parsePositiveInt(process.env.OTP_FETCH_LIMIT, 30);
  const sinceGraceSeconds = parsePositiveInt(process.env.OTP_SINCE_GRACE_SECONDS, 90);

  return {
    port: Number.isFinite(port) ? port : 80,
    host,
    mailbox,
    secure,
    user,
    pass,
    lookbackMinutes,
    fetchLimit,
    sinceGraceMs: sinceGraceSeconds * 1000,
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
  private lastConnectionError: string | null = null;

  constructor(private readonly env: EnvConfig) { }

  async findOtp(email: string, since: number): Promise<OtpResult> {
    const normalizedEmail = normalizeEmail(email);
    console.log("[otp-debug] request", JSON.stringify({
      email,
      normalizedEmail,
      since,
      sinceIso: toIsoString(since),
    }));

    try {
      const { candidates, debug } = await this.fetchCandidates(email, normalizedEmail, since);
      let fallbackMatch: OtpResult | null = null;

      for (const candidate of candidates) {
        try {
          const parsed = await simpleParser(candidate.source);
          const text = getSearchableMailText(parsed);
          const otp = extractOtp(text);
          const matchedEmail = matchesParsedFrom(parsed.from, normalizedEmail);
          const candidateDebug: DebugCandidate = {
            uid: candidate.uid,
            receivedAt: candidate.receivedAt,
            receivedAtIso: toIsoString(candidate.receivedAt),
            from: parsed.from?.text ?? null,
            subject: parsed.subject ?? null,
            otp,
            matchedEmail,
          };

          debug.candidates.push(candidateDebug);
          console.log("[otp-debug] candidate", JSON.stringify(candidateDebug));

          if (!otp) {
            continue;
          }

          if (!fallbackMatch) {
            debug.matchedCandidateUid = candidate.uid;
            debug.matchedBy = normalizedEmail ? "fallback" : "email";
            fallbackMatch = {
              email,
              otp,
              receivedAt: candidate.receivedAt,
              matchedBy: normalizedEmail ? "fallback" : "email",
              error: null,
              debug,
            };
          }

          if (matchedEmail) {
            debug.matchedCandidateUid = candidate.uid;
            debug.matchedBy = "email";

            const result: OtpResult = {
              email,
              otp,
              receivedAt: candidate.receivedAt,
              matchedBy: "email",
              error: null,
              debug,
            };

            console.log("[otp-debug] result", JSON.stringify({
              email,
              matchedBy: result.matchedBy,
              matchedCandidateUid: debug.matchedCandidateUid,
              candidateCount: debug.candidates.length,
              error: result.error,
            }));
            return result;
          }
        } catch (error) {
          const parseError = serializeError(error);
          debug.candidates.push({
            uid: candidate.uid,
            receivedAt: candidate.receivedAt,
            receivedAtIso: toIsoString(candidate.receivedAt),
            from: null,
            subject: null,
            otp: null,
            matchedEmail: false,
          });
          console.error("Parse mail error:", error);
          console.log("[otp-debug] candidate-parse-error", JSON.stringify({
            uid: candidate.uid,
            receivedAt: candidate.receivedAt,
            receivedAtIso: toIsoString(candidate.receivedAt),
            error: parseError,
          }));
        }
      }

      if (fallbackMatch) {
        console.log("[otp-debug] result", JSON.stringify({
          email,
          matchedBy: fallbackMatch.matchedBy,
          matchedCandidateUid: debug.matchedCandidateUid,
          candidateCount: debug.candidates.length,
          error: fallbackMatch.error,
        }));
        return fallbackMatch;
      }

      const result: OtpResult = {
        email,
        otp: null,
        receivedAt: null,
        matchedBy: null,
        error: null,
        debug,
      };

      console.log("[otp-debug] result", JSON.stringify({
        email,
        matchedBy: result.matchedBy,
        matchedCandidateUid: debug.matchedCandidateUid,
        candidateCount: debug.candidates.length,
        error: result.error,
      }));
      return result;
    } catch (error) {
      const debug = this.createDebug(email, normalizedEmail, since);
      debug.connectionError = this.lastConnectionError;
      debug.fetchError = serializeError(error);

      const result: OtpResult = {
        email,
        otp: null,
        receivedAt: null,
        matchedBy: null,
        error: debug.fetchError,
        debug,
      };

      console.error("Find OTP error:", error);
      console.log("[otp-debug] result", JSON.stringify({
        email,
        matchedBy: result.matchedBy,
        matchedCandidateUid: debug.matchedCandidateUid,
        candidateCount: debug.candidates.length,
        error: result.error,
      }));
      return result;
    }
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

  private createDebug(email: string, normalizedEmail: string, since: number): OtpDebug {
    const now = Date.now();
    const effectiveSince = Math.max(0, since - this.env.sinceGraceMs);
    const searchSince = since - this.env.lookbackMinutes * 60_000;

    return {
      email,
      normalizedEmail,
      host: this.env.host,
      mailbox: this.env.mailbox,
      now,
      nowIso: toIsoString(now),
      since,
      sinceIso: toIsoString(since),
      effectiveSince,
      effectiveSinceIso: toIsoString(effectiveSince),
      searchSince,
      searchSinceIso: toIsoString(searchSince),
      lookbackMinutes: this.env.lookbackMinutes,
      sinceGraceMs: this.env.sinceGraceMs,
      fetchLimit: this.env.fetchLimit,
      uidCount: 0,
      recentUidCount: 0,
      recentUids: [],
      fetchedMessageCount: 0,
      filteredMessageCount: 0,
      matchedCandidateUid: null,
      matchedBy: null,
      connectionError: this.lastConnectionError,
      fetchError: null,
      candidates: [],
    };
  }

  private async fetchCandidates(email: string, normalizedEmail: string, since: number): Promise<FetchCandidatesResult> {
    const client = await this.getClient();
    const lock = await client.getMailboxLock(this.env.mailbox);
    const debug = this.createDebug(email, normalizedEmail, since);

    try {
      const effectiveSince = debug.effectiveSince;
      const searchSince = new Date(debug.searchSince);
      const uids = (await client.search({ since: searchSince }, { uid: true })) || [];
      debug.uidCount = uids.length;

      if (uids.length === 0) {
        console.log("[otp-debug] fetch-summary", JSON.stringify({
          email,
          normalizedEmail,
          since: debug.since,
          effectiveSince: debug.effectiveSince,
          searchSince: debug.searchSince,
          uidCount: debug.uidCount,
          recentUidCount: debug.recentUidCount,
          fetchedMessageCount: debug.fetchedMessageCount,
          filteredMessageCount: debug.filteredMessageCount,
          connectionError: debug.connectionError,
        }));
        return { candidates: [], debug };
      }

      const recentUids = uids.slice(-this.env.fetchLimit);
      debug.recentUids = recentUids;
      debug.recentUidCount = recentUids.length;
      const messages = await client.fetchAll(
        recentUids,
        {
          envelope: true,
          internalDate: true,
          source: true,
        },
        { uid: true }
      );
      debug.fetchedMessageCount = messages.length;

      const candidates = messages
        .map((message) => toMailCandidate(message))
        .filter((message): message is MailCandidate => Boolean(message))
        .filter((message) => message.receivedAt >= effectiveSince)
        .sort((a, b) => b.receivedAt - a.receivedAt || b.uid - a.uid);
      debug.filteredMessageCount = candidates.length;

      console.log("[otp-debug] fetch-summary", JSON.stringify({
        email,
        normalizedEmail,
        since: debug.since,
        effectiveSince: debug.effectiveSince,
        searchSince: debug.searchSince,
        uidCount: debug.uidCount,
        recentUidCount: debug.recentUidCount,
        recentUids: debug.recentUids,
        fetchedMessageCount: debug.fetchedMessageCount,
        filteredMessageCount: debug.filteredMessageCount,
        connectionError: debug.connectionError,
      }));

      return { candidates, debug };
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
        this.lastConnectionError = serializeError(error);
        console.error("IMAP connection error:", error);
      });

      await client.connect();
      this.lastConnectionError = null;
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

server.listen(config.port, '0.0.0.0', () => {
  console.log(`OTP server is listening on http://0.0.0.0:${config.port}`);
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
    source: message.source,
    receivedAt: new Date(message.internalDate).getTime(),
  };
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function matchesParsedFrom(from: AddressObject | undefined, email: string): boolean {
  if (!email) {
    return true;
  }

  if (!from) {
    return false;
  }

  return (
    from.value.some((entry: { address?: string | null }) => normalizeEmail(entry.address ?? "") === email) ||
    normalizeEmail(from.text).includes(email)
  );
}

function getSearchableMailText(parsed: Pick<ParsedMail, "text" | "html">): string {
  const parts = [parsed.text ?? ""];

  if (typeof parsed.html === "string") {
    parts.push(parsed.html);
  }

  return normalize(parts.filter(Boolean).join("\n"));
}

function normalize(text: string): string {
  return text
    .replace(/=\r?\n/g, "")
    .replace(/=20/g, " ")
    .replace(/=3D/g, "=")
    .replace(/\u00A0/g, " ")
    .trim();
}

function extractOtp(text: string): string | null {
  const patterns = [
    /otp[^0-9]{0,30}([0-9]{4,8})/i,
    /code[^0-9]{0,30}([0-9]{4,8})/i,
    /verification[^0-9]{0,30}([0-9]{4,8})/i,
    /password[^0-9]{0,30}([0-9]{4,8})/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) return match[1];
  }

  const matches = text.match(/\b\d{4,8}\b/g) || [];

  return (
    matches
      .reverse()
      .find((value) => {
        const parsed = Number(value);
        return !(parsed >= 1900 && parsed <= 2099);
      }) ?? null
  );
}

function serializeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === "string") {
    return error;
  }

  try {
    return JSON.stringify(error);
  } catch {
    return "Unknown error";
  }
}

function toIsoString(value: number): string {
  return new Date(value).toISOString();
}
