import { expect, test } from "bun:test";
import { generateKeyPairSync, verify, createPublicKey } from "node:crypto";
import { AirlockError, RunRefusedError, createAirlock, SUITE_ID } from "../src/airlock";
import { seal } from "../src/hpke";
import { createHandler } from "../src/server";

const DIGEST = "sha256:" + "ab".repeat(32);
const RUN = "0123456789abcdef0123456789abcdef";
const cfg = { api: "https://airlock.test", org: "org-test", workloadId: "wl-1", digest: DIGEST, rebitServerId: "srv-1", rebitHost: "aa.test", environment: "sandbox" };
const decode = (p: string) => JSON.parse(Buffer.from(p, "base64url").toString());

function setup(o: { refuse?: boolean; expireFirst?: boolean } = {}) {
  const sys = generateKeyPairSync("ed25519");
  const reply = generateKeyPairSync("x25519");
  const calls: string[] = [];
  const seenJti = new Set<string>();
  let requestClaims: any;
  let expired = !!o.expireFirst;
  let polls = 0;

  const fake = (async (url: string, init: any = {}) => {
    const u = new URL(url);
    const key = `${init.method ?? "GET"} ${u.pathname}`;
    calls.push(key);
    const j = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
    const checkPresentation = (jws: string) => {
      const [h, p, sig] = jws.split(".");
      expect(decode(h!).typ).toBe("vp+jwt");
      expect(decode(h!).kid).toBe(al.kid);
      expect(verify(null, Buffer.from(`${h}.${p}`), sys.publicKey, Buffer.from(sig!, "base64url"))).toBe(true);
      const c = decode(p!);
      expect(c.vc).toBe("CREDENTIAL");
      expect(seenJti.has(c.jti)).toBe(false);
      seenJti.add(c.jti);
      return c;
    };
    if (key === "POST /v1/auth/token") {
      const body = JSON.parse(init.body);
      const c = checkPresentation(body.assertion);
      expect(c.aud).toBe("https://airlock.test/v1/auth/token");
      expect(c.exp - c.iat).toBeLessThanOrEqual(300);
      return j(200, { accessToken: "tok" + calls.length, tokenType: "Bearer", expiresIn: 900 });
    }
    if (expired) { expired = false; return j(401, { error: { errorCode: "TOKEN_EXPIRED" } }); }
    if (init.headers.authorization === undefined) return j(401, {});
    if (key === "POST /v1/workloads/wl-1/runs") {
      const b = JSON.parse(init.body);
      expect(b.request).toEqual({ source: "rebit", rebitServerId: "srv-1", consentId: "sandbox-ok", fiDataRange: { from: "2026-06-01T00:00:00Z", to: "2026-11-19T00:00:00Z" } });
      expect(b.request.sealedParameters).toBeUndefined();
      return j(202, { dispatch_id: "d1", status: "queued", expires_at: "x" });
    }
    if (key === "GET /v1/dispatches/d1") return j(200, { status: "accepted", run_id: RUN });
    if (key === "GET /v1/runs" && !u.searchParams.has("cursor")) return j(200, { runs: [{ id: "row-0", runId: "other" }], nextCursor: "c1" });
    if (key === "GET /v1/runs") {
      return j(200, { runs: [{ id: "row-1", runId: RUN, sessionExpiresAt: new Date(Date.now() + 7200_000).toISOString() }], nextCursor: null });
    }
    if (key === "PUT /v1/runs/row-1/request") {
      const c = checkPresentation(JSON.parse(init.body).jws);
      requestClaims = c;
      return j(201, { kid: "k", jti: c.jti, uploaded_at: "t" });
    }
    if (key === "GET /v1/runs/row-1") return j(200, { status: ++polls < 2 ? "open" : "completed" });
    if (key === "GET /v1/runs/row-1/chain") {
      return j(200, { verdict: "ok?", receipts: [
        { signed: { body: { type: "enclave.attested" } } },
        ...(o.refuse ? [{ signed: { body: { type: "output.refused", attributes: { "airlock.refusal.reason": "recipient_key_missing" } } } }] : []),
        { signed: { body: { type: "data.deleted" } } },
      ] });
    }
    if (key === "GET /v1/runs/row-1/output") {
      if (o.refuse) return j(404, { error: { errorCode: "OUTPUT_NOT_FOUND" } });
      const raw = Buffer.from(reply.publicKey.export({ format: "jwk" }).x!, "base64url");
      const s = seal({ recipientPublicRaw: raw, info: new TextEncoder().encode(`airlock.reply.v1|${RUN}|${DIGEST}`), pt: Buffer.from(JSON.stringify({ spend: 42 })), ephemeral: generateKeyPairSync("x25519") });
      return new Response(JSON.stringify({ suite: SUITE_ID, enc: s.enc.toString("base64url"), ct: s.ct.toString("base64url") }));
    }
    return j(500, { error: { errorCode: "UNEXPECTED " + key } });
  }) as unknown as typeof fetch;

  const al = createAirlock(cfg, { systemKey: sys.privateKey, credential: "CREDENTIAL", replyKey: reply.privateKey }, { fetch: fake, sleep: async () => undefined });
  return { al, calls, reply, sys, claims: () => requestClaims };
}
const RANGE = { from: "2026-06-01T00:00:00Z", to: "2026-11-19T00:00:00Z" };

test("full run: login, start, queued→accepted, find row on page 2, signed request, poll, open reply", async () => {
  const t = setup();
  const stages: string[] = [];
  const r = await t.al.run("sandbox-ok", RANGE, (s) => stages.push(s));
  expect(r.answer).toEqual({ spend: 42 });
  expect(stages).toEqual(["starting", "waiting_for_vm", "request_signed", "running", "fetching_reply"]);
  const c = t.claims();
  expect(c).toMatchObject({ iss: "org-test", aud: RUN, manifest_digest: DIGEST, input: { source: "rebit", rebit_server: "aa.test", consent_id: "sandbox-ok", fi_data_range: RANGE } });
  expect(c.input.sealed_digest).toBeUndefined();
  expect(c.exp - c.iat).toBeLessThanOrEqual(600);
  expect(t.calls.filter((x) => x === "POST /v1/auth/token").length).toBe(1);
});

test("a 401 logs in again once and repeats the call", async () => {
  const t = setup({ expireFirst: true });
  await t.al.run("sandbox-ok", RANGE);
  expect(t.calls.filter((x) => x === "POST /v1/auth/token").length).toBe(2);
});

test("a completed run with no reply raises RunRefusedError carrying the receipt reason", async () => {
  const t = setup({ refuse: true });
  const e = await t.al.run("sandbox-ok", RANGE).catch((x) => x);
  expect(e).toBeInstanceOf(RunRefusedError);
  expect(e.refusals).toEqual([["output.refused", "recipient_key_missing"]]);
});

test("a reply sealed to another key or run id does not open", async () => {
  const t = setup();
  const r = await t.al.run("sandbox-ok", RANGE);
  const other = createAirlock(cfg, { systemKey: t.sys.privateKey, credential: "C", replyKey: generateKeyPairSync("x25519").privateKey });
  const raw = Buffer.from(t.reply.publicKey.export({ format: "jwk" }).x!, "base64url");
  const s = seal({ recipientPublicRaw: raw, info: new TextEncoder().encode(`airlock.reply.v1|${RUN}|${DIGEST}`), pt: Buffer.from("{}"), ephemeral: generateKeyPairSync("x25519") });
  const env = Buffer.from(JSON.stringify({ suite: SUITE_ID, enc: s.enc.toString("base64url"), ct: s.ct.toString("base64url") }));
  expect(() => other.openReply(env, RUN)).toThrow();
  expect(() => t.al.openReply(env, "f".repeat(32))).toThrow();
  expect(r.runId).toBe(RUN);
});

// ── server routes ────────────────────────────────────────────────────────────
function server(run: any) {
  const logs: string[] = [];
  const h = createHandler({
    audience: "a", log: (e, f) => logs.push(JSON.stringify({ e, ...f })),
    airlock: { run, environment: "sandbox", agentDigest: DIGEST, workloadId: "wl-1", consentIds: ["sandbox-ok", "sandbox-manual"], rangeDays: 90 },
  });
  const req = (method: string, path: string, token?: string, body?: unknown) =>
    h(new Request("http://x" + path, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }));
  return { req, logs };
}
const login = async (s: ReturnType<typeof server>, id = "customer-test-001") =>
  ((await (await s.req("POST", "/v1/session", undefined, { customerId: id })).json()) as any).token as string;

test("server: POST /v1/runs is async; GET returns the answer and evidence; chain downloads; logs hold no answer", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const s = server(async (_c: string, _r: any, onStage: any) => {
    onStage("running", RUN); await gate;
    return { runId: RUN, answer: { spend: 42, secretMarker: "ZZZ-MARKER" }, chain: { verdict: "ok?", receipts: [{ signed: { body: { type: "enclave.attested", issued_at: "2026-11-20T00:00:00Z" } } }, { signed: { body: { type: "data.deleted" } } }] } };
  });
  const tok = await login(s);
  expect((await s.req("POST", "/v1/runs", tok, { consentId: "not-allowed" })).status).toBe(400);
  const started = await s.req("POST", "/v1/runs", tok, { consentId: "sandbox-ok" });
  expect(started.status).toBe(202);
  const { id } = (await started.json()) as any;
  expect((await s.req("POST", "/v1/runs", tok, {})).status).toBe(429); // one in flight
  const mid: any = await (await s.req("GET", `/v1/runs/${id}`, tok)).json();
  expect(mid).toMatchObject({ status: "running", stage: "running", runId: RUN });
  expect(mid.answer).toBeUndefined();
  release(); await new Promise((r) => setTimeout(r, 10));
  const done: any = await (await s.req("GET", `/v1/runs/${id}`, tok)).json();
  expect(done.status).toBe("completed");
  expect(done.answer.spend).toBe(42);
  expect(done.chain).toBeUndefined(); // chain only via the download route
  expect(done.evidence).toMatchObject({ runId: RUN, environment: "sandbox", agentDigest: DIGEST, consentId: "sandbox-ok", independentlyVerified: false, receipts: [{ type: "enclave.attested", at: "2026-11-20T00:00:00Z" }, { type: "data.deleted" }] });
  const list: any = await (await s.req("GET", "/v1/runs", tok)).json();
  expect(list.runs).toHaveLength(1);
  expect(list.runs[0]).toMatchObject({ id, status: "completed", answer: { spend: 42 } });
  expect(list.runs[0].chain).toBeUndefined();
  expect(list.runs[0].customer).toBeUndefined();
  const chain = await s.req("GET", `/v1/runs/${id}/chain`, tok);
  expect(chain.headers.get("content-disposition")).toContain(`run-${RUN}.chain.json`);
  expect(s.logs.join("\n")).not.toContain("ZZZ-MARKER");
  // another customer cannot read it
  const other = await login(s, "customer-test-002");
  expect((await s.req("GET", `/v1/runs/${id}`, other)).status).toBe(404);
  expect(((await (await s.req("GET", "/v1/runs", other)).json()) as any).runs).toEqual([]);
  expect((await s.req("GET", `/v1/runs/${id}`)).status).toBe(401);
});

test("server: a refused run reports the receipt reasons, and an api error reports only its type", async () => {
  const s1 = server(async () => { throw new RunRefusedError(RUN, [["fi.refused", "fi_fetch_timeout"]]); });
  const t1 = await login(s1);
  const { id } = (await (await s1.req("POST", "/v1/runs", t1, {})).json()) as any;
  await new Promise((r) => setTimeout(r, 10));
  expect(await (await s1.req("GET", `/v1/runs/${id}`, t1)).json()).toMatchObject({ status: "failed", error: { type: "RunRefusedError", refusals: [["fi.refused", "fi_fetch_timeout"]] } });

  const s2 = server(async () => { throw new AirlockError(409, "NO_ORG_VM", { secret: "detail" }, "req-1"); });
  const t2 = await login(s2);
  const r2 = (await (await s2.req("POST", "/v1/runs", t2, {})).json()) as any;
  await new Promise((r) => setTimeout(r, 10));
  const st: any = await (await s2.req("GET", `/v1/runs/${r2.id}`, t2)).json();
  expect(st.error).toEqual({ type: "AirlockError" });
  expect(JSON.stringify(st)).not.toContain("detail");
});

test("server: with an access key, sessions need it (and nothing else changes)", async () => {
  const h = createHandler({ audience: "a", accessKey: "k".repeat(20), airlock: { run: async () => { throw new Error("x"); }, environment: "sandbox", agentDigest: DIGEST, workloadId: "w", consentIds: ["sandbox-ok"], rangeDays: 1 } });
  const post = (key?: string) => h(new Request("http://x/v1/session", { method: "POST", headers: key ? { "x-access-key": key } : {}, body: JSON.stringify({ customerId: "customer-test-001" }) }));
  expect((await post()).status).toBe(401);
  expect((await post("wrong")).status).toBe(401);
  expect((await post("k".repeat(20))).status).toBe(200);
});
