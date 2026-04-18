import "dotenv/config";
import { randomUUID } from "node:crypto";
import { createServer, IncomingMessage, ServerResponse } from "node:http";
import process from "node:process";
import { ImapFlow, ImapFlowOptions, FetchMessageObject } from "imapflow";
import { AddressObject, HeaderLines, ParsedMail, simpleParser } from "mailparser";

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

type MatchMode = "recipient";
type SessionStatus = "waiting" | "resolved";
type OtpSessionStatus = SessionStatus | "expired";

type SessionState = {
  id: string;
  email: string;
  normalizedEmail: string;
  startedAt: number;
  effectiveSince: number;
  status: SessionStatus;
  claimedUid: number | null;
  otp: string | null;
  receivedAt: number | null;
  matchedBy: MatchMode | null;
  lastAccessedAt: number;
};

type SessionCreateResult = {
  sessionId: string;
  email: string;
  startedAt: number;
  effectiveSince: number;
};

type ClaimRecord = {
  sessionId: string;
  email: string;
  uid: number;
  otp: string;
  receivedAt: number;
  matchedBy: MatchMode;
  claimedAt: number;
};

type OtpResult = {
  sessionId: string | null;
  sessionStatus: OtpSessionStatus;
  email: string;
  otp: string | null;
  receivedAt: number | null;
  matchedBy: MatchMode | null;
  error: string | null;
  debug: OtpDebug;
};

type MailCandidate = {
  uid: number;
  source: Buffer;
  receivedAt: number;
};

type ParsedCandidate = {
  uid: number;
  receivedAt: number;
  from: string | null;
  subject: string | null;
  otp: string | null;
  recipientEmails: string[];
  recipientHeaderKeys: string[];
};

type DebugCandidate = {
  uid: number;
  receivedAt: number;
  receivedAtIso: string;
  from: string | null;
  subject: string | null;
  otp: string | null;
  matchedEmail: boolean;
  recipientEmails: string[];
  recipientHeaderKeys: string[];
  claimedBySessionId: string | null;
  claimedByEmail: string | null;
};

type OtpDebug = {
  sessionId: string | null;
  sessionStatus: OtpSessionStatus;
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
  matchedBy: MatchMode | null;
  activeSessionCount: number;
  waitingSessionCount: number;
  claimedUidCount: number;
  connectionError: string | null;
  fetchError: string | null;
  candidates: DebugCandidate[];
};

type FetchCandidatesResult = {
  candidates: MailCandidate[];
  debug: OtpDebug;
};

type ParsedCandidatesResult = {
  parsedCandidates: ParsedCandidate[];
  debugCandidates: DebugCandidate[];
};

const config = loadConfig();
const RECIPIENT_HEADER_KEYS = [
  "to",
  "cc",
  "bcc",
  "delivered-to",
  "x-delivered-to",
  "x-original-to",
  "envelope-to",
  "original-recipient",
  "x-forwarded-to",
  "resent-to",
  "apparently-to",
];

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

  if (req.method === "POST" && url.pathname === "/session") {
    const body = await readJsonBodySafely(req, res);
    if (!body) {
      return;
    }

    const email = typeof body.email === "string" ? body.email.trim() : "";
    if (!email) {
      sendJson(res, 400, { error: "Email is required." });
      return;
    }

    const session = imapService.createSession(email);
    sendJson(res, 201, session);
    return;
  }

  if (req.method === "GET" && url.pathname === "/otp") {
    const sessionId = url.searchParams.get("sessionId")?.trim() ?? "";
    if (!sessionId) {
      sendJson(res, 400, { error: "sessionId is required." });
      return;
    }

    const result = await imapService.findOtpBySession(sessionId);
    sendJson(res, 200, result);
    return;
  }

  if (req.method === "POST" && url.pathname === "/clear") {
    const body = await readJsonBodySafely(req, res);
    if (!body) {
      return;
    }

    const sessionId = typeof body.sessionId === "string" ? body.sessionId.trim() : "";
    sendJson(res, 200, { success: imapService.closeSession(sessionId) });
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

async function readJsonBodySafely(
  req: IncomingMessage,
  res: ServerResponse
): Promise<Record<string, unknown> | null> {
  try {
    return await readJsonBody(req);
  } catch (error) {
    sendJson(res, 400, { error: serializeError(error) || "Invalid JSON body." });
    return null;
  }
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];

  for await (const chunk of req) {
    if (typeof chunk === "string") {
      chunks.push(Buffer.from(chunk));
      continue;
    }

    chunks.push(chunk);
  }

  if (chunks.length === 0) {
    return {};
  }

  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) {
    return {};
  }

  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("JSON body must be an object.");
  }

  return parsed as Record<string, unknown>;
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
  private sessions = new Map<string, SessionState>();
  private claims = new Map<number, ClaimRecord>();
  private assignmentQueue: Promise<void> = Promise.resolve();

  constructor(private readonly env: EnvConfig) {}

  createSession(email: string): SessionCreateResult {
    const now = Date.now();
    this.cleanupState(now);

    const session: SessionState = {
      id: randomUUID(),
      email,
      normalizedEmail: normalizeEmail(email),
      startedAt: now,
      effectiveSince: Math.max(0, now - this.env.sinceGraceMs),
      status: "waiting",
      claimedUid: null,
      otp: null,
      receivedAt: null,
      matchedBy: null,
      lastAccessedAt: now,
    };

    this.sessions.set(session.id, session);

    console.log("[otp-debug] session-created", JSON.stringify({
      sessionId: session.id,
      email: session.email,
      startedAt: session.startedAt,
      startedAtIso: toIsoString(session.startedAt),
      effectiveSince: session.effectiveSince,
      effectiveSinceIso: toIsoString(session.effectiveSince),
    }));

    return {
      sessionId: session.id,
      email: session.email,
      startedAt: session.startedAt,
      effectiveSince: session.effectiveSince,
    };
  }

  closeSession(sessionId: string): boolean {
    if (!sessionId) {
      return false;
    }

    const didDelete = this.sessions.delete(sessionId);
    if (didDelete) {
      console.log("[otp-debug] session-cleared", JSON.stringify({ sessionId }));
    }

    return didDelete;
  }

  async findOtpBySession(sessionId: string): Promise<OtpResult> {
    return this.withAssignmentLock(async () => {
      const now = Date.now();
      this.cleanupState(now);

      const session = this.sessions.get(sessionId);
      if (!session) {
        return this.createExpiredSessionResult(sessionId);
      }

      session.lastAccessedAt = now;

      if (session.status === "resolved") {
        const debug = this.createDebug(session.email, session.normalizedEmail, session.startedAt, session.id);
        this.populateDebug(debug, [], [], session);
        return this.toOtpResult(session, debug);
      }

      try {
        const { candidates, debug } = await this.fetchCandidates(
          session.email,
          session.normalizedEmail,
          session.startedAt,
          session.id
        );
        const { parsedCandidates, debugCandidates } = await this.parseCandidates(candidates);

        this.assignCandidates(parsedCandidates);

        const updatedSession = this.sessions.get(sessionId);
        if (!updatedSession) {
          return this.createExpiredSessionResult(sessionId);
        }

        updatedSession.lastAccessedAt = Date.now();
        this.populateDebug(debug, parsedCandidates, debugCandidates, updatedSession);

        const result = this.toOtpResult(updatedSession, debug);
        console.log("[otp-debug] result", JSON.stringify({
          sessionId,
          email: result.email,
          sessionStatus: result.sessionStatus,
          matchedBy: result.matchedBy,
          matchedCandidateUid: debug.matchedCandidateUid,
          candidateCount: debug.candidates.length,
          error: result.error,
        }));
        return result;
      } catch (error) {
        const debug = this.createDebug(session.email, session.normalizedEmail, session.startedAt, session.id);
        debug.connectionError = this.lastConnectionError;
        debug.fetchError = serializeError(error);
        this.populateDebug(debug, [], [], session);

        console.error("Find OTP error:", error);
        const result: OtpResult = {
          sessionId: session.id,
          sessionStatus: "waiting",
          email: session.email,
          otp: null,
          receivedAt: null,
          matchedBy: null,
          error: debug.fetchError,
          debug,
        };

        console.log("[otp-debug] result", JSON.stringify({
          sessionId,
          email: result.email,
          sessionStatus: result.sessionStatus,
          matchedBy: result.matchedBy,
          matchedCandidateUid: debug.matchedCandidateUid,
          candidateCount: debug.candidates.length,
          error: result.error,
        }));
        return result;
      }
    });
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

  private async withAssignmentLock<T>(task: () => Promise<T>): Promise<T> {
    const previous = this.assignmentQueue;
    let release = () => {};

    this.assignmentQueue = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previous;

    try {
      return await task();
    } finally {
      release();
    }
  }

  private createExpiredSessionResult(sessionId: string): OtpResult {
    const now = Date.now();
    const debug = this.createDebug("", "", now, sessionId);
    this.populateDebug(debug, [], [], null);

    return {
      sessionId,
      sessionStatus: "expired",
      email: "",
      otp: null,
      receivedAt: null,
      matchedBy: null,
      error: "Session expired or reset. Start listening again.",
      debug,
    };
  }

  private toOtpResult(session: SessionState, debug: OtpDebug): OtpResult {
    return {
      sessionId: session.id,
      sessionStatus: session.status,
      email: session.email,
      otp: session.otp,
      receivedAt: session.receivedAt,
      matchedBy: session.matchedBy,
      error: null,
      debug,
    };
  }

  private createDebug(
    email: string,
    normalizedEmail: string,
    since: number,
    sessionId: string | null
  ): OtpDebug {
    const now = Date.now();
    const effectiveSince = Math.max(0, since - this.env.sinceGraceMs);
    const searchSince = since - this.env.lookbackMinutes * 60_000;

    return {
      sessionId,
      sessionStatus: "waiting",
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
      activeSessionCount: 0,
      waitingSessionCount: 0,
      claimedUidCount: 0,
      connectionError: this.lastConnectionError,
      fetchError: null,
      candidates: [],
    };
  }

  private async fetchCandidates(
    email: string,
    normalizedEmail: string,
    since: number,
    sessionId: string
  ): Promise<FetchCandidatesResult> {
    const client = await this.getClient();
    const lock = await client.getMailboxLock(this.env.mailbox);
    const debug = this.createDebug(email, normalizedEmail, since, sessionId);

    try {
      const searchSince = new Date(debug.searchSince);
      const uids = (await client.search({ since: searchSince }, { uid: true })) || [];
      debug.uidCount = uids.length;

      if (uids.length === 0) {
        console.log("[otp-debug] fetch-summary", JSON.stringify({
          sessionId,
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
        .filter((message) => message.receivedAt >= debug.effectiveSince)
        .sort((a, b) => b.receivedAt - a.receivedAt || b.uid - a.uid);
      debug.filteredMessageCount = candidates.length;

      console.log("[otp-debug] fetch-summary", JSON.stringify({
        sessionId,
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

  private async parseCandidates(candidates: MailCandidate[]): Promise<ParsedCandidatesResult> {
    const parsedCandidates: ParsedCandidate[] = [];
    const debugCandidates: DebugCandidate[] = [];

    for (const candidate of candidates) {
      try {
        const parsed = await simpleParser(candidate.source);
        const text = getSearchableMailText(parsed);
        const otp = extractOtp(text);

        parsedCandidates.push({
          uid: candidate.uid,
          receivedAt: candidate.receivedAt,
          from: parsed.from?.text ?? null,
          subject: parsed.subject ?? null,
          otp,
          recipientEmails: getRecipientEmails(parsed),
          recipientHeaderKeys: getPresentRecipientHeaderKeys(parsed.headerLines),
        });
      } catch (error) {
        const claim = this.claims.get(candidate.uid);

        debugCandidates.push({
          uid: candidate.uid,
          receivedAt: candidate.receivedAt,
          receivedAtIso: toIsoString(candidate.receivedAt),
          from: null,
          subject: null,
          otp: null,
          matchedEmail: false,
          recipientEmails: [],
          recipientHeaderKeys: [],
          claimedBySessionId: claim?.sessionId ?? null,
          claimedByEmail: claim?.email ?? null,
        });

        console.error("Parse mail error:", error);
        console.log("[otp-debug] candidate-parse-error", JSON.stringify({
          uid: candidate.uid,
          receivedAt: candidate.receivedAt,
          receivedAtIso: toIsoString(candidate.receivedAt),
          error: serializeError(error),
        }));
      }
    }

    return { parsedCandidates, debugCandidates };
  }

  private assignCandidates(parsedCandidates: ParsedCandidate[]) {
    const waitingSessions = Array.from(this.sessions.values())
      .filter((session) => session.status === "waiting")
      .sort(compareSessions);

    const candidatesInChronologicalOrder = [...parsedCandidates].sort(compareParsedCandidatesAsc);

    for (const candidate of candidatesInChronologicalOrder) {
      if (!candidate.otp || this.claims.has(candidate.uid)) {
        continue;
      }

      const eligibleSessions = waitingSessions.filter(
        (session) => session.effectiveSince <= candidate.receivedAt
      );

      if (eligibleSessions.length === 0) {
        continue;
      }

      const exactMatches = eligibleSessions.filter((session) =>
        this.candidateMatchesSession(candidate, session.normalizedEmail)
      );

      if (exactMatches.length === 0) {
        console.log("[otp-debug] candidate-unclaimed", JSON.stringify({
          uid: candidate.uid,
          receivedAt: candidate.receivedAt,
          receivedAtIso: toIsoString(candidate.receivedAt),
          recipientEmails: candidate.recipientEmails,
          reason: "no-recipient-match",
        }));
        continue;
      }

      const distinctMatchedEmails = new Set(exactMatches.map((session) => session.normalizedEmail));
      if (distinctMatchedEmails.size > 1) {
        console.log("[otp-debug] candidate-unclaimed", JSON.stringify({
          uid: candidate.uid,
          receivedAt: candidate.receivedAt,
          receivedAtIso: toIsoString(candidate.receivedAt),
          recipientEmails: candidate.recipientEmails,
          matchedSessionIds: exactMatches.map((session) => session.id),
          matchedEmails: Array.from(distinctMatchedEmails),
          reason: "ambiguous-recipient-match",
        }));
        continue;
      }

      const targetSession = exactMatches[0];
      if (!targetSession) {
        continue;
      }

      const matchedBy: MatchMode = "recipient";

      this.claimCandidate(targetSession, candidate, matchedBy);

      const waitingIndex = waitingSessions.findIndex((session) => session.id === targetSession.id);
      if (waitingIndex >= 0) {
        waitingSessions.splice(waitingIndex, 1);
      }
    }
  }

  private claimCandidate(session: SessionState, candidate: ParsedCandidate, matchedBy: MatchMode) {
    if (!candidate.otp) {
      return;
    }

    session.status = "resolved";
    session.claimedUid = candidate.uid;
    session.otp = candidate.otp;
    session.receivedAt = candidate.receivedAt;
    session.matchedBy = matchedBy;
    session.lastAccessedAt = Date.now();

    this.claims.set(candidate.uid, {
      sessionId: session.id,
      email: session.email,
      uid: candidate.uid,
      otp: candidate.otp,
      receivedAt: candidate.receivedAt,
      matchedBy,
      claimedAt: Date.now(),
    });

    console.log("[otp-debug] candidate-claimed", JSON.stringify({
      sessionId: session.id,
      email: session.email,
      uid: candidate.uid,
      receivedAt: candidate.receivedAt,
      receivedAtIso: toIsoString(candidate.receivedAt),
      matchedBy,
    }));
  }

  private populateDebug(
    debug: OtpDebug,
    parsedCandidates: ParsedCandidate[],
    debugCandidates: DebugCandidate[],
    session: SessionState | null
  ) {
    debug.activeSessionCount = this.sessions.size;
    debug.waitingSessionCount = Array.from(this.sessions.values()).filter(
      (candidateSession) => candidateSession.status === "waiting"
    ).length;
    debug.claimedUidCount = this.claims.size;
    debug.sessionStatus = session?.status ?? "expired";
    debug.matchedCandidateUid = session?.claimedUid ?? null;
    debug.matchedBy = session?.matchedBy ?? null;

    const parsedDebugCandidates = parsedCandidates.map((candidate) => {
      const claim = this.claims.get(candidate.uid);

      return {
        uid: candidate.uid,
        receivedAt: candidate.receivedAt,
        receivedAtIso: toIsoString(candidate.receivedAt),
        from: candidate.from,
        subject: candidate.subject,
        otp: candidate.otp,
        recipientEmails: candidate.recipientEmails,
        recipientHeaderKeys: candidate.recipientHeaderKeys,
        matchedEmail: session ? this.candidateMatchesSession(candidate, session.normalizedEmail) : false,
        claimedBySessionId: claim?.sessionId ?? null,
        claimedByEmail: claim?.email ?? null,
      };
    });

    debug.candidates = [...debugCandidates, ...parsedDebugCandidates].sort(
      (a, b) => b.receivedAt - a.receivedAt || b.uid - a.uid
    );
  }

  private candidateMatchesSession(candidate: ParsedCandidate, normalizedEmail: string): boolean {
    if (!normalizedEmail) {
      return false;
    }

    return candidate.recipientEmails.includes(normalizedEmail);
  }

  private cleanupState(now: number) {
    const sessionTtlMs = Math.max(this.env.lookbackMinutes * 60_000 * 2, 30 * 60_000);
    const claimTtlMs = Math.max(sessionTtlMs * 2, 60 * 60_000);

    for (const [sessionId, session] of this.sessions) {
      if (now - session.lastAccessedAt > sessionTtlMs) {
        this.sessions.delete(sessionId);
      }
    }

    for (const [uid, claim] of this.claims) {
      const hasActiveSession = this.sessions.has(claim.sessionId);
      if (!hasActiveSession && now - claim.claimedAt > claimTtlMs) {
        this.claims.delete(uid);
      }
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

server.listen(config.port, "0.0.0.0", () => {
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

function compareSessions(a: SessionState, b: SessionState): number {
  return a.startedAt - b.startedAt || a.id.localeCompare(b.id);
}

function compareParsedCandidatesAsc(a: ParsedCandidate, b: ParsedCandidate): number {
  return a.receivedAt - b.receivedAt || a.uid - b.uid;
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

function getRecipientEmails(parsed: Pick<ParsedMail, "to" | "cc" | "bcc" | "headerLines">): string[] {
  return uniqueNormalizedEmails([
    ...extractEmailsFromAddressObject(parsed.to),
    ...extractEmailsFromAddressObject(parsed.cc),
    ...extractEmailsFromAddressObject(parsed.bcc),
    ...extractEmailsFromHeaderLines(parsed.headerLines, RECIPIENT_HEADER_KEYS),
  ]);
}

function getPresentRecipientHeaderKeys(headerLines: HeaderLines): string[] {
  return Array.from(
    new Set(
      headerLines
        .map((entry) => entry.key.trim().toLowerCase())
        .filter((key) => RECIPIENT_HEADER_KEYS.includes(key))
    )
  );
}

function extractEmailsFromAddressObject(value: AddressObject | AddressObject[] | undefined): string[] {
  if (!value) {
    return [];
  }

  const list = Array.isArray(value) ? value : [value];
  return list.flatMap((entry) =>
    entry.value
      .map((addressEntry) => normalizeEmail(addressEntry.address ?? ""))
      .filter(Boolean)
  );
}

function extractEmailsFromHeaderLines(headerLines: HeaderLines, keys: string[]): string[] {
  const allowedKeys = new Set(keys.map((key) => key.toLowerCase()));

  return headerLines.flatMap((entry) => {
    const key = entry.key.trim().toLowerCase();
    if (!allowedKeys.has(key)) {
      return [];
    }

    return extractEmails(entry.line);
  });
}

function extractEmails(text: string): string[] {
  return text.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi) ?? [];
}

function uniqueNormalizedEmails(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => normalizeEmail(value)).filter(Boolean)));
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
    if (match?.[1]) {
      return match[1];
    }
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
