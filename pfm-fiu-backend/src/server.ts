/**
 * MOCK FIU backend — the relay in ADR-006 option D / PFM-DESIGN §6.
 *
 * What it is: the FIU's own server. It authenticates the app, holds the slot's
 * queue-requester identity (in queue mode), forwards the app's job to the
 * enclave and returns the reply. What it deliberately is NOT:
 *
 *   - a reader. The reply is sealed to the device key and the request carries a
 *     presentation the ENCLAVE verifies; the relay never decodes either. Its
 *     logs hold ids, sizes and error types only.
 *   - a verifier. It cannot make a presentation more trustworthy by checking it.
 *   - a data holder. It stores the latest sealed reply (ciphertext) so app opens
 *     are served from storage and never cause an AA fetch (PFM-DESIGN §11).
 *
 * Auth here is a mock: POST /v1/session issues a bearer token for a synthetic
 * customer. A real FIU would put its own login in front of the same routes.
 *
 * Routes
 *   GET  /v1/config           { audience }                 VP audience the app must use
 *   POST /v1/session          { customerId }               → { token }   (customer-test-* only)
 *   POST /v1/credentials      { holder:{did,jwk} }         → { agent, consent }  (mock mode only)
 *   POST /v1/insights         { jobId, body }              → { outcome, output | errorType }
 *   GET  /v1/insights/latest                               → { jobId, output } | 404
 *
 * Airlock mode (Octic handoff) replaces the relay routes: the backend runs the
 * whole Airlock flow as the FIU's system and returns the opened reply, so unlike
 * the relay it DOES see the insights (the reply is sealed to the org's key).
 *   POST /v1/runs             { consentId? }                → 202 { id }
 *   GET  /v1/runs                                           → { runs: [{ id, status, stage, answer?, evidence?, error? }] } newest first, this customer's, since boot
 *   GET  /v1/runs/:id                                       → { status, stage, answer?, evidence?, error? }
 *   GET  /v1/runs/:id/chain                                 → the chain export (download)
 */
import { timingSafeEqual } from "node:crypto";
import { didKeyFromP256Jwk, type P256PublicJwk } from "../../pfm-client/src/lib/didkey";
import type { MockIssuer } from "../../pfm-client/src/mock/issuer";
import { ReplyTimeoutError, type Transport } from "../../pfm-client/src/transport/types";
import { RunRefusedError, type Range, type Stage } from "./airlock";

export const MAX_BODY_BYTES = 64 * 1024;
const UUID = /^[0-9a-f-]{16,64}$/i;

/** What the server needs from Airlock: one whole run, progress by stage. */
export interface AirlockRunner {
  run(consentId: string, range: Range, onStage: (s: Stage, runId?: string) => void): Promise<{ runId: string; answer: unknown; chain: any }>;
  environment: string;
  agentDigest: string;
  workloadId: string;
  /** Consent ids the app may ask for (the demo's, all synthetic). First is the default. */
  consentIds: string[];
  /** Inclusive window the range is derived from: days back from now. */
  rangeDays: number;
}

export interface Deps {
  transport?: Transport;
  airlock?: AirlockRunner;
  audience: string;
  /** Present in mock mode only; queue mode has no issuance path yet. */
  issuer?: MockIssuer;
  /** Log sink. Callers must pass only ids, counts and error types — enforced by the field type. */
  log?: (event: string, fields: Record<string, string | number | boolean>) => void;
  allowedOrigins?: string[];
  /** If set, POST /v1/session needs header `x-access-key` equal to it. Airlock mode requires one: it spends the org's system identity. */
  accessKey?: string;
}

interface Stored { jobId: string; output: string }

interface RunState {
  customer: string;
  status: "running" | "completed" | "failed";
  stage: Stage;
  runId?: string;
  consentId: string;
  startedAt: string;
  answer?: unknown;
  chain?: unknown;
  evidence?: Evidence;
  error?: { type: string; refusals?: Array<[string, string | null]> };
}
interface Evidence {
  runId: string; environment: string; agentWorkloadId: string; agentDigest: string; consentId: string; startedAt: string;
  /** Receipt types in chain order, enclave.attested … data.deleted; `at` only when the receipt carries a string timestamp. */
  receipts: Array<{ type: string; at?: string }>;
  /** The api's own verdict, passed through UNVERIFIED — the independent check is `airlock verify-note` over the chain export. */
  apiVerdict: unknown;
  independentlyVerified: false;
}

export const evidenceOf = (a: AirlockRunner, runId: string, consentId: string, startedAt: string, chain: any): Evidence => ({
  runId, environment: a.environment, agentWorkloadId: a.workloadId, agentDigest: a.agentDigest, consentId, startedAt,
  receipts: (chain?.receipts ?? []).map((rc: any) => {
    const b = rc?.signed?.body ?? {};
    const at = [b.issued_at, b.timestamp, b.at, b.time].find((x) => typeof x === "string");
    return { type: String(b.type ?? "unknown"), ...(at ? { at } : {}) };
  }),
  apiVerdict: chain?.verdict ?? null,
  independentlyVerified: false,
});

const DEFAULT_ORIGINS = ["http://localhost:1420", "http://tauri.localhost", "https://tauri.localhost", "tauri://localhost"];

export function createHandler(d: Deps): (req: Request) => Promise<Response> {
  const log = d.log ?? (() => undefined);
  const origins = d.allowedOrigins ?? DEFAULT_ORIGINS;
  const sessions = new Map<string, string>(); // token → customerId
  const inFlight = new Set<string>(); // customerId
  const seenJobs = new Set<string>();
  const latest = new Map<string, Stored>(); // customerId → sealed reply
  const runs = new Map<string, RunState>(); // run handle → state (memory only; replies are derived customer facts)

  const json = (status: number, body: unknown, cors: Record<string, string>): Response =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...cors } });

  return async (req) => {
    const origin = req.headers.get("origin");
    const cors: Record<string, string> = origin && origins.includes(origin)
      ? { "access-control-allow-origin": origin, vary: "origin", "access-control-allow-headers": "authorization, content-type, x-access-key", "access-control-allow-methods": "GET, POST, OPTIONS" }
      : {};
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    const url = new URL(req.url);
    const route = `${req.method} ${url.pathname}`;

    const readJson = async (): Promise<Record<string, any> | Response> => {
      const text = await req.text();
      if (text.length > MAX_BODY_BYTES) return json(413, { error: "too large" }, cors);
      try {
        const v = JSON.parse(text);
        return v && typeof v === "object" && !Array.isArray(v) ? v : json(400, { error: "expected an object" }, cors);
      } catch {
        return json(400, { error: "invalid json" }, cors);
      }
    };
    const customer = (): string | undefined => sessions.get((req.headers.get("authorization") ?? "").replace(/^Bearer /, ""));

    if (route === "GET /v1/config") return json(200, { audience: d.audience, mode: d.airlock ? "airlock" : d.issuer ? "mock" : "queue" }, cors);

    if (route === "POST /v1/session") {
      if (d.accessKey !== undefined) {
        const given = Buffer.from(req.headers.get("x-access-key") ?? "");
        const want = Buffer.from(d.accessKey);
        if (given.length !== want.length || !timingSafeEqual(given, want)) return json(401, { error: "access key required" }, cors);
      }
      const b = await readJson();
      if (b instanceof Response) return b;
      const id = String(b["customerId"] ?? "");
      if (!/^customer-test-[a-z0-9-]{1,32}$/.test(id)) return json(403, { error: "synthetic customers only" }, cors);
      const token = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replace(/[+/=]/g, "");
      sessions.set(token, id);
      log("session_opened", { customer: id });
      return json(200, { token }, cors);
    }

    const who = customer();
    if (!who) return json(401, { error: "unauthenticated" }, cors);

    if (route === "POST /v1/credentials") {
      if (!d.issuer) return json(501, { error: "no issuance path in this mode — import credentials from your issuer" }, cors);
      const b = await readJson();
      if (b instanceof Response) return b;
      const jwk = b["holder"]?.jwk as P256PublicJwk | undefined;
      try {
        if (!jwk || didKeyFromP256Jwk(jwk) !== b["holder"]?.did) throw new Error();
      } catch {
        return json(400, { error: "holder.did must be the did:key of holder.jwk (P-256)" }, cors);
      }
      const bundle = await d.issuer.issue({ did: b["holder"].did, jwk });
      log("credentials_issued", { customer: who });
      return json(200, bundle, cors);
    }

    if (d.airlock) {
      const a = d.airlock;
      if (route === "POST /v1/runs") {
        const b = await readJson();
        if (b instanceof Response) return b;
        const consentId = String(b["consentId"] ?? a.consentIds[0]);
        if (!a.consentIds.includes(consentId)) return json(400, { error: "consentId not allowed", allowed: a.consentIds }, cors);
        for (const r of runs.values()) if (r.customer === who && r.status === "running") return json(429, { error: "a run is already in flight" }, cors);
        const id = crypto.randomUUID();
        const to = new Date();
        const range = { from: new Date(to.getTime() - a.rangeDays * 864e5).toISOString().replace(/\.\d+Z$/, "Z"), to: to.toISOString().replace(/\.\d+Z$/, "Z") };
        const st: RunState = { customer: who, status: "running", stage: "starting", consentId, startedAt: to.toISOString() };
        runs.set(id, st);
        log("run_started", { id, customer: who, consentId });
        // Not awaited: the run takes 40–50 s (sandbox-ok) or waits for a human (sandbox-manual).
        a.run(consentId, range, (stage, runId) => { st.stage = stage; if (runId) st.runId = runId; })
          .then((r) => {
            st.status = "completed"; st.runId = r.runId; st.answer = r.answer; st.chain = r.chain;
            st.evidence = evidenceOf(a, r.runId, consentId, st.startedAt, r.chain);
            log("run_completed", { id, runId: r.runId });
          })
          .catch((e) => {
            st.status = "failed";
            st.error = e instanceof RunRefusedError ? { type: "RunRefusedError", refusals: e.refusals } : { type: e instanceof Error ? e.constructor.name : "Error" };
            log("run_failed", { id, errorType: st.error.type, ...(st.runId ? { runId: st.runId } : {}) }); // never e.message: may echo api detail
          });
        return json(202, { id }, cors);
      }
      if (route === "GET /v1/runs") {
        const mine = [...runs].filter(([, r]) => r.customer === who).reverse(); // Map keeps insertion order
        return json(200, { runs: mine.map(([id, { customer: _c, chain: _ch, ...pub }]) => ({ id, ...pub })) }, cors);
      }
      const m = /^\/v1\/runs\/([0-9a-f-]{36})(\/chain)?$/.exec(url.pathname);
      if (req.method === "GET" && m) {
        const st = runs.get(m[1]!);
        if (!st || st.customer !== who) return json(404, { error: "no such run" }, cors);
        if (m[2]) {
          if (!st.chain) return json(404, { error: "no chain yet" }, cors);
          return new Response(JSON.stringify(st.chain), { headers: { "content-type": "application/json", "cache-control": "no-store", "content-disposition": `attachment; filename="run-${st.runId}.chain.json"`, ...cors } });
        }
        const { customer: _c, chain: _ch, ...pub } = st;
        return json(200, pub, cors);
      }
      return json(404, { error: "not found" }, cors);
    }
    if (!d.transport) return json(404, { error: "not found" }, cors);

    if (route === "POST /v1/insights") {
      const b = await readJson();
      if (b instanceof Response) return b;
      const jobId = String(b["jobId"] ?? "");
      const body = b["body"];
      if (!UUID.test(jobId) || !body || typeof body !== "object" || typeof body.vp !== "string" || typeof body.replyTo !== "object") {
        return json(400, { error: "expected { jobId, body: { vp, replyTo, … } }" }, cors);
      }
      if (seenJobs.has(jobId)) return json(409, { error: "jobId already used" }, cors);
      if (inFlight.has(who)) return json(429, { error: "a request is already in flight" }, cors);
      seenJobs.add(jobId);
      inFlight.add(who);
      const started = Date.now();
      try {
        log("job_relayed", { jobId, customer: who, bytes: JSON.stringify(body).length });
        const reply = await d.transport.send({ jobId, body });
        log("job_replied", { jobId, outcome: reply.outcome, ms: Date.now() - started, ...(reply.outcome === "ok" ? { bytes: reply.output.length } : { errorType: reply.errorType }) });
        if (reply.outcome === "ok") latest.set(who, { jobId, output: reply.output }); // ciphertext + counts only
        return json(200, reply, cors);
      } catch (e) {
        const kind = e instanceof ReplyTimeoutError ? "ReplyTimeoutError" : "TransportError";
        log("job_failed", { jobId, errorType: kind });
        return json(e instanceof ReplyTimeoutError ? 504 : 502, { error: kind }, cors);
      } finally {
        inFlight.delete(who);
      }
    }

    if (route === "GET /v1/insights/latest") {
      const s = latest.get(who);
      return s ? json(200, s, cors) : json(404, { error: "nothing stored yet" }, cors);
    }

    return json(404, { error: "not found" }, cors);
  };
}
