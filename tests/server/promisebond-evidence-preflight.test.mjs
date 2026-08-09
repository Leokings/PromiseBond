import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";

import { createPromiseBondApp } from "../../server/promisebond/app.js";
import {
  EVIDENCE_SOURCE_MAX_BYTES,
  EvidencePreflightError,
  createEvidencePreflight,
  isPublicEvidenceAddress,
  validateEvidencePreflightInput
} from "../../server/promisebond/evidence-preflight.js";
import { createPromiseBondRepository } from "../../server/promisebond/repository.js";
import { createPromiseBondRuntime } from "../../server/promisebond/runtime.js";

const URLS = [
  "https://alpha.example/evidence.txt",
  "https://beta.example/evidence.html",
  "https://gamma.example/evidence.json"
];
const PUBLIC_ADDRESS = "93.184.216.34";

function input(urls = URLS) {
  return { urls };
}

function bodyFrom(...chunks) {
  return (async function* streamBody() {
    for (const chunk of chunks) yield Buffer.from(chunk);
  }());
}

function publicResolver() {
  return [{ address: PUBLIC_ADDRESS, family: 4 }];
}

function fakeResponse(body, overrides = {}) {
  return {
    status: 200,
    headers: { "content-type": "text/plain; charset=utf-8" },
    body: bodyFrom(body),
    remoteAddress: PUBLIC_ADDRESS,
    ...overrides
  };
}

async function listen(app) {
  const server = await new Promise((resolve) => {
    const candidate = app.listen(0, "127.0.0.1", () => resolve(candidate));
  });
  const address = server.address();
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    })
  };
}

test("preflight input requires exactly three distinct canonical HTTPS authorities", () => {
  assert.deepEqual(validateEvidencePreflightInput(input()).map(({ raw }) => raw), URLS);

  const invalidInputs = [
    {},
    { urls: URLS.slice(0, 2) },
    { urls: [...URLS, "https://delta.example/"] },
    { urls: URLS, headers: { authorization: "Bearer attacker-controlled" } },
    input([URLS[0], URLS[0], URLS[2]]),
    input([URLS[0], "https://alpha.example/other", URLS[2]]),
    input(["http://alpha.example/", URLS[1], URLS[2]]),
    input(["https://user:secret@alpha.example/", URLS[1], URLS[2]]),
    input(["https://alpha.example:8443/", URLS[1], URLS[2]]),
    input(["https://alpha.example/path#fragment", URLS[1], URLS[2]]),
    input(["https://alpha.example/%zz", URLS[1], URLS[2]]),
    input(["https://Alpha.example/", URLS[1], URLS[2]]),
    input(["https://alpha.example", URLS[1], URLS[2]]),
    input(["https://1.2.3.999/", URLS[1], URLS[2]]),
    input(["https://localhost/", URLS[1], URLS[2]]),
    input(["https://127.0.0.1/", URLS[1], URLS[2]]),
    input(["https://[::1]/", URLS[1], URLS[2]]),
    input(["https://[2606:4700:4700::1111]/", URLS[1], URLS[2]]),
    input(["https://alpha.example/'", URLS[1], URLS[2]]),
    input(["https://one.alpha.example/evidence", "https://two.alpha.example/evidence", URLS[2]])
  ];
  for (const candidate of invalidInputs) {
    assert.throws(
      () => validateEvidencePreflightInput(candidate),
      (error) => error instanceof EvidencePreflightError && error.status === 400 &&
        error.code === "INVALID_EVIDENCE_URLS"
    );
  }
});

test("public-address policy rejects local, private, link-local, documentation, multicast, and reserved IPs", () => {
  for (const address of [
    "0.0.0.0",
    "10.0.0.1",
    "100.64.0.1",
    "127.0.0.1",
    "169.254.169.254",
    "172.16.0.1",
    "192.0.2.1",
    "192.168.1.1",
    "198.18.0.1",
    "198.51.100.2",
    "203.0.113.2",
    "224.0.0.1",
    "255.255.255.255",
    "::",
    "::1",
    "fe80::1",
    "fc00::1",
    "ff02::1",
    "2001:db8::1",
    "3fff::1",
    "::ffff:127.0.0.1"
  ]) {
    assert.equal(isPublicEvidenceAddress(address), false, address);
  }
  for (const address of ["1.1.1.1", "8.8.8.8", "2606:4700:4700::1111", "::ffff:8.8.8.8"]) {
    assert.equal(isPublicEvidenceAddress(address), true, address);
  }
});

test("preflight accepts a bounded 24-address public anycast answer and rejects an oversized set", async () => {
  const publicRecords = Array.from({ length: 24 }, (_, index) => ({
    address: `104.16.${Math.floor(index / 12)}.${34 + (index % 12)}`,
    family: 4
  }));
  const fetchSource = async ({ addresses, url }) => {
    assert.equal(addresses.length, 24);
    return fakeResponse(`evidence for ${url.hostname}`, { remoteAddress: addresses[0].address });
  };
  const accepted = createEvidencePreflight({
    resolveHostname: async () => publicRecords,
    fetchSource
  });
  assert.equal((await accepted(input())).passed, true);

  const rejected = createEvidencePreflight({
    resolveHostname: async () => Array.from({ length: 33 }, (_, index) => ({
      address: `8.8.${Math.floor(index / 250)}.${1 + (index % 250)}`,
      family: 4
    })),
    fetchSource
  });
  await assert.rejects(
    rejected(input()),
    (error) => error instanceof EvidencePreflightError && error.code === "EVIDENCE_DNS_REJECTED"
  );
});

test("preflight streams allowed bodies into ordered metadata with bounded concurrency and no raw-body output", async () => {
  const bodies = new Map([
    ["alpha.example", "plain evidence secret"],
    ["beta.example", "<html>html evidence secret</html>"],
    ["gamma.example", "{\"vendor\":\"json evidence secret\"}"]
  ]);
  const contentTypes = new Map([
    ["alpha.example", "text/plain; charset=UTF-8"],
    ["beta.example", "text/html"],
    ["gamma.example", "application/vnd.promisebond+json; version=1"]
  ]);
  let active = 0;
  let peak = 0;
  const preflight = createEvidencePreflight({
    resolveHostname: async () => publicResolver(),
    maxConcurrency: 2,
    fetchSource: async (options) => {
      assert.deepEqual(Object.keys(options).sort(), ["addresses", "signal", "url"]);
      active += 1;
      peak = Math.max(peak, active);
      await delay(10);
      active -= 1;
      const hostname = options.url.hostname;
      return fakeResponse(bodies.get(hostname), {
        headers: { "content-type": contentTypes.get(hostname) }
      });
    }
  });

  const result = await preflight(input());
  assert.equal(result.passed, true);
  assert.equal(peak, 2);
  assert.deepEqual(result.sources.map(({ url }) => url), URLS);
  assert.deepEqual(result.sources.map(({ contentType }) => contentType), [
    "text/plain",
    "text/html",
    "application/vnd.promisebond+json"
  ]);
  for (const source of result.sources) {
    const body = bodies.get(new URL(source.url).hostname);
    assert.equal(source.status, 200);
    assert.equal(source.bytes, Buffer.byteLength(body));
    assert.equal(source.sha256, createHash("sha256").update(body).digest("hex"));
    assert.equal(source.pass, true);
    assert.equal(Object.keys(source).includes("body"), false);
  }
  assert.doesNotMatch(JSON.stringify(result), /evidence secret/);
});

test("DNS answers and the connected address are both constrained to the validated public set", async (t) => {
  await t.test("one private record poisons a mixed DNS answer", async () => {
    const preflight = createEvidencePreflight({
      resolveHostname: async () => [
        { address: PUBLIC_ADDRESS, family: 4 },
        { address: "10.20.30.40", family: 4 }
      ],
      fetchSource: async () => fakeResponse("should not be fetched")
    });
    await assert.rejects(
      preflight(input()),
      (error) => error instanceof EvidencePreflightError && error.code === "EVIDENCE_DNS_REJECTED"
    );
  });

  await t.test("an IPv6 link-local DNS answer is rejected", async () => {
    const preflight = createEvidencePreflight({
      resolveHostname: async () => [{ address: "fe80::1234", family: 6 }],
      fetchSource: async () => fakeResponse("should not be fetched")
    });
    await assert.rejects(
      preflight(input()),
      (error) => error instanceof EvidencePreflightError && error.code === "EVIDENCE_DNS_REJECTED"
    );
  });

  await t.test("the actual remote address must match the pre-resolved address", async () => {
    const preflight = createEvidencePreflight({
      resolveHostname: async () => publicResolver(),
      fetchSource: async () => fakeResponse("body", { remoteAddress: "1.1.1.1" })
    });
    await assert.rejects(
      preflight(input()),
      (error) => error instanceof EvidencePreflightError && error.code === "EVIDENCE_CONNECTION_REJECTED"
    );
  });
});

test("redirects, failed statuses, and unsupported media types fail closed", async (t) => {
  for (const [name, response, code] of [
    ["redirect", fakeResponse("moved", { status: 302, headers: { location: "https://other.example/", "content-type": "text/plain" } }), "EVIDENCE_REDIRECT_REJECTED"],
    ["failed status", fakeResponse("missing", { status: 404 }), "EVIDENCE_HTTP_REJECTED"],
    ["unsupported media", fakeResponse("binary", { headers: { "content-type": "application/octet-stream" } }), "EVIDENCE_CONTENT_TYPE_REJECTED"],
    ["missing media", fakeResponse("unknown", { headers: {} }), "EVIDENCE_CONTENT_TYPE_REJECTED"],
    ["gzip encoding", fakeResponse("compressed", { headers: { "content-type": "text/plain", "content-encoding": "gzip" } }), "EVIDENCE_CONTENT_ENCODING_REJECTED"],
    ["brotli encoding", fakeResponse("compressed", { headers: { "content-type": "text/plain", "content-encoding": "br" } }), "EVIDENCE_CONTENT_ENCODING_REJECTED"]
  ]) {
    await t.test(name, async () => {
      const preflight = createEvidencePreflight({
        resolveHostname: async () => publicResolver(),
        maxConcurrency: 1,
        fetchSource: async () => response
      });
      await assert.rejects(
        preflight(input()),
        (error) => error instanceof EvidencePreflightError && error.code === code
      );
    });
  }
});

test("header rejection destroys an unread response body", async () => {
  for (const headers of [
    { "content-type": "text/plain", "content-encoding": "gzip" },
    { "content-type": "application/octet-stream" }
  ]) {
    let destroyed = false;
    const preflight = createEvidencePreflight({
      resolveHostname: async () => publicResolver(),
      maxConcurrency: 1,
      fetchSource: async () => ({
        status: 200,
        headers,
        body: {
          destroy() { destroyed = true; },
          async *[Symbol.asyncIterator]() { yield Buffer.from("must not be read"); }
        },
        remoteAddress: PUBLIC_ADDRESS
      })
    });
    await assert.rejects(preflight(input()), EvidencePreflightError);
    assert.equal(destroyed, true);
  }
});

test("the byte cap rejects oversized streams instead of truncating and rejects empty bodies", async (t) => {
  await t.test("exactly 12000 bytes pass", async () => {
    const preflight = createEvidencePreflight({
      resolveHostname: async () => publicResolver(),
      fetchSource: async () => fakeResponse(Buffer.alloc(EVIDENCE_SOURCE_MAX_BYTES, 1))
    });
    const result = await preflight(input());
    assert.deepEqual(result.sources.map(({ bytes }) => bytes), [12_000, 12_000, 12_000]);
  });

  await t.test("byte 12001 rejects the entire preflight", async () => {
    const preflight = createEvidencePreflight({
      resolveHostname: async () => publicResolver(),
      maxConcurrency: 1,
      fetchSource: async () => ({
        status: 200,
        headers: { "content-type": "application/json" },
        body: bodyFrom(Buffer.alloc(EVIDENCE_SOURCE_MAX_BYTES), "x"),
        remoteAddress: PUBLIC_ADDRESS
      })
    });
    await assert.rejects(
      preflight(input()),
      (error) => error instanceof EvidencePreflightError && error.code === "EVIDENCE_TOO_LARGE"
    );
  });

  await t.test("an oversized Content-Length fails before streaming", async () => {
    let iterations = 0;
    const preflight = createEvidencePreflight({
      resolveHostname: async () => publicResolver(),
      maxConcurrency: 1,
      fetchSource: async () => ({
        status: 200,
        headers: { "content-type": "text/plain", "content-length": "12001" },
        body: (async function* unreadBody() { iterations += 1; yield "not read"; }()),
        remoteAddress: PUBLIC_ADDRESS
      })
    });
    await assert.rejects(
      preflight(input()),
      (error) => error instanceof EvidencePreflightError && error.code === "EVIDENCE_TOO_LARGE"
    );
    assert.equal(iterations, 0);
  });

  await t.test("an empty successful response fails", async () => {
    const preflight = createEvidencePreflight({
      resolveHostname: async () => publicResolver(),
      maxConcurrency: 1,
      fetchSource: async () => fakeResponse("", { body: bodyFrom() })
    });
    await assert.rejects(
      preflight(input()),
      (error) => error instanceof EvidencePreflightError && error.code === "EVIDENCE_EMPTY"
    );
  });

  await t.test("a whitespace-only successful response fails", async () => {
    const preflight = createEvidencePreflight({
      resolveHostname: async () => publicResolver(),
      maxConcurrency: 1,
      fetchSource: async () => fakeResponse(" \t\r\n ")
    });
    await assert.rejects(
      preflight(input()),
      (error) => error instanceof EvidencePreflightError && error.code === "EVIDENCE_EMPTY"
    );
  });

  await t.test("Python-only control separators and NEL count as empty on-chain", async () => {
    for (const body of ["\u001c\u001d\u001e\u001f", "\u0085"]) {
      const preflight = createEvidencePreflight({
        resolveHostname: async () => publicResolver(),
        maxConcurrency: 1,
        fetchSource: async () => fakeResponse(body)
      });
      await assert.rejects(
        preflight(input()),
        (error) => error instanceof EvidencePreflightError && error.code === "EVIDENCE_EMPTY"
      );
    }
  });
});

test("each source has an aborting timeout no greater than eight seconds", async () => {
  let aborted = false;
  const preflight = createEvidencePreflight({
    resolveHostname: async () => publicResolver(),
    timeoutMs: 20,
    maxConcurrency: 1,
    fetchSource: async ({ signal }) => new Promise((_, reject) => {
      signal.addEventListener("abort", () => {
        aborted = true;
        reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      }, { once: true });
    })
  });
  await assert.rejects(
    preflight(input()),
    (error) => error instanceof EvidencePreflightError && error.status === 504 &&
      error.code === "EVIDENCE_SOURCE_TIMEOUT"
  );
  assert.equal(aborted, true);
});

test("repository atomically enforces global and hashed-client source cost in one fixed-window document", async () => {
  const calls = [];
  let document;
  let simulateConcurrentInsert = true;
  const quotas = {
    async updateOne(filter, update, options) {
      calls.push(["updateOne", filter, update, options]);
      if (!document) {
        document = { ...update.$setOnInsert };
        if (simulateConcurrentInsert) {
          simulateConcurrentInsert = false;
          throw Object.assign(new Error("competing process inserted the window"), { code: 11_000 });
        }
      }
      return { upsertedCount: document ? 1 : 0 };
    },
    async findOneAndUpdate(filter, update, options) {
      calls.push(["findOneAndUpdate", filter, update, options]);
      const clientPath = Object.keys(update.$inc).find((path) => path.startsWith("clients."));
      const clientHash = clientPath.slice("clients.".length);
      const clientCost = Number(document.clients[clientHash] || 0);
      const globalAllowed = document.globalCost <= filter.globalCost.$lte;
      const clientAllowed = clientCost <= filter.$or[1][clientPath].$lte;
      if (!globalAllowed || !clientAllowed) return null;
      document.globalCost += update.$inc.globalCost;
      document.clients[clientHash] = clientCost + update.$inc[clientPath];
      document.updatedAt = update.$set.updatedAt;
      return { ...document, clients: { ...document.clients } };
    },
    async findOne(filter, options) {
      calls.push(["findOne", filter, options]);
      return document ? { ...document, clients: { ...document.clients } } : null;
    }
  };
  const database = {
    collection(name) {
      return name === "promisebond_evidence_preflight_quotas" ? quotas : {};
    }
  };
  const consumedAt = new Date("2026-08-10T12:00:20.000Z");
  const repository = createPromiseBondRepository({ database, now: () => consumedAt });
  const clientA = "a".repeat(64);
  const clientB = "b".repeat(64);
  const consume = (clientHash) => repository.consumeEvidencePreflightQuota({
    clientHash,
    cost: 3,
    globalLimit: 9,
    clientLimit: 6,
    windowMs: 60_000,
    consumedAt
  });

  const clientAResults = await Promise.all([consume(clientA), consume(clientA), consume(clientA)]);
  assert.deepEqual(clientAResults.map(({ allowed }) => allowed), [true, true, false]);
  assert.equal(clientAResults[2].scope, "client");

  const clientBResults = await Promise.all([consume(clientB), consume(clientB)]);
  assert.deepEqual(clientBResults.map(({ allowed }) => allowed), [true, false]);
  assert.equal(clientBResults[1].scope, "global");
  assert.equal(document.globalCost, 9);
  assert.deepEqual(document.clients, { [clientA]: 6, [clientB]: 3 });
  assert.equal(document.bucketId, `evidence-preflight:${Date.parse("2026-08-10T12:00:00.000Z")}`);
  assert.equal(document.expiresAt.toISOString(), "2026-08-10T12:01:00.000Z");

  const atomicCall = calls.find(([name]) => name === "findOneAndUpdate");
  assert.deepEqual(atomicCall[1].globalCost, { $lte: 6 });
  assert.deepEqual(atomicCall[1].$or, [
    { [`clients.${clientA}`]: { $exists: false } },
    { [`clients.${clientA}`]: { $lte: 3 } }
  ]);
  assert.deepEqual(atomicCall[2].$inc, { globalCost: 3, [`clients.${clientA}`]: 3 });
  assert.doesNotMatch(JSON.stringify(calls), /127\.0\.0\.1|x-forwarded-for/i);
  await assert.rejects(
    repository.consumeEvidencePreflightQuota({
      clientHash: "127.0.0.1",
      cost: 3,
      globalLimit: 9,
      clientLimit: 6,
      windowMs: 60_000,
      consumedAt
    }),
    /lowercase SHA-256 digest/
  );
});

test("runtime trusts exactly one Vercel ingress hop by default while direct deployments remain untrusted", () => {
  const names = ["VERCEL", "PROMISEBOND_TRUST_PROXY", "PROMISEBOND_CRON_SECRET", "CRON_SECRET"];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  const secret = "vercel-runtime-quota-test-secret";
  try {
    process.env.VERCEL = "1";
    delete process.env.PROMISEBOND_TRUST_PROXY;
    process.env.PROMISEBOND_CRON_SECRET = secret;
    process.env.CRON_SECRET = secret;
    assert.equal(createPromiseBondRuntime().app.get("trust proxy"), 1);

    process.env.PROMISEBOND_TRUST_PROXY = "false";
    assert.equal(createPromiseBondRuntime().app.get("trust proxy"), false);

    delete process.env.VERCEL;
    delete process.env.PROMISEBOND_TRUST_PROXY;
    assert.equal(createPromiseBondRuntime().app.get("trust proxy"), false);
  } finally {
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
});

test("the API route consumes durable hashed-client quota before injected outbound work", async () => {
  let repositoryCalls = 0;
  const quotaCalls = [];
  let received;
  const app = createPromiseBondApp({
    getRepository: async () => {
      repositoryCalls += 1;
      return {
        async consumeEvidencePreflightQuota(value) {
          quotaCalls.push(value);
          return { allowed: true, resetAt: new Date("2026-08-10T12:01:00.000Z") };
        }
      };
    },
    getReadClient: async () => ({}),
    createRequestId: () => "preflight-request-id",
    now: () => Date.parse("2026-08-10T12:00:20.000Z"),
    preflightEvidence: async (value) => {
      received = value;
      if (value.urls[0].includes("reject")) {
        throw new EvidencePreflightError(422, "EVIDENCE_REDIRECT_REJECTED", "Evidence source redirects are not allowed");
      }
      return { passed: true, sources: [{ url: value.urls[0], status: 200, contentType: "text/plain", bytes: 2, sha256: "a".repeat(64), pass: true }] };
    },
    logger: { error() {} }
  });
  const server = await listen(app);
  try {
    const response = await fetch(`${server.baseUrl}/api/promisebond/evidence/preflight`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-evidence-header": "must-not-be-forwarded",
        "x-forwarded-for": "203.0.113.99"
      },
      body: JSON.stringify(input())
    });
    assert.equal(response.status, 200);
    assert.deepEqual(received, input());
    assert.deepEqual(await response.json(), {
      passed: true,
      sources: [{ url: URLS[0], status: 200, contentType: "text/plain", bytes: 2, sha256: "a".repeat(64), pass: true }],
      requestId: "preflight-request-id"
    });
    assert.equal(repositoryCalls, 1);
    assert.equal(quotaCalls.length, 1);
    assert.match(quotaCalls[0].clientHash, /^[0-9a-f]{64}$/);
    assert.equal(quotaCalls[0].cost, 3);
    assert.equal(quotaCalls[0].globalLimit, 300);
    assert.equal(quotaCalls[0].clientLimit, 15);
    assert.equal(quotaCalls[0].windowMs, 60_000);
    assert.equal(quotaCalls[0].consumedAt.toISOString(), "2026-08-10T12:00:20.000Z");
    assert.doesNotMatch(JSON.stringify(quotaCalls), /127\.0\.0\.1|203\.0\.113\.99/);

    const nonJson = await fetch(`${server.baseUrl}/api/promisebond/evidence/preflight`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "not json"
    });
    assert.equal(nonJson.status, 415);
    assert.equal((await nonJson.json()).error.code, "CONTENT_TYPE_REQUIRED");

    const rejected = await fetch(`${server.baseUrl}/api/promisebond/evidence/preflight`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input(["https://reject.example/", URLS[1], URLS[2]]))
    });
    assert.equal(rejected.status, 422);
    assert.equal((await rejected.json()).error.code, "EVIDENCE_REDIRECT_REJECTED");
    assert.equal(repositoryCalls, 2);
    assert.equal(quotaCalls.length, 2);
  } finally {
    await server.close();
  }
});

test("Vercel-forwarded clients receive distinct durable quota identities", async () => {
  const costs = new Map();
  const quotaCalls = [];
  let outboundCalls = 0;
  const repository = {
    async consumeEvidencePreflightQuota(value) {
      quotaCalls.push(value);
      const current = costs.get(value.clientHash) || 0;
      if (current + value.cost > value.clientLimit) {
        return { allowed: false, scope: "client", resetAt: new Date("2026-08-10T12:01:00.000Z") };
      }
      costs.set(value.clientHash, current + value.cost);
      return { allowed: true, resetAt: new Date("2026-08-10T12:01:00.000Z") };
    }
  };
  const app = createPromiseBondApp({
    getRepository: async () => repository,
    getReadClient: async () => ({}),
    trustProxy: true,
    evidencePreflightClientSourceLimit: 3,
    evidencePreflightClientHashKey: "shared-vercel-client-hash-key",
    now: () => Date.parse("2026-08-10T12:00:20.000Z"),
    preflightEvidence: async () => {
      outboundCalls += 1;
      return { passed: true, sources: [] };
    },
    logger: { error() {} }
  });
  const server = await listen(app);
  async function request(clientAddress) {
    return fetch(`${server.baseUrl}/api/promisebond/evidence/preflight`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": clientAddress },
      body: JSON.stringify(input())
    });
  }
  try {
    assert.equal((await request("198.51.100.10")).status, 200);
    assert.equal((await request("198.51.100.11")).status, 200);
    const repeated = await request("198.51.100.10");
    assert.equal(repeated.status, 429);
    assert.equal((await repeated.json()).error.code, "EVIDENCE_PREFLIGHT_QUOTA_EXCEEDED");
    assert.equal(outboundCalls, 2);
    assert.equal(quotaCalls.length, 3);
    assert.notEqual(quotaCalls[0].clientHash, quotaCalls[1].clientHash);
    assert.equal(quotaCalls[0].clientHash, quotaCalls[2].clientHash);
    assert.doesNotMatch(JSON.stringify(quotaCalls), /198\.51\.100\.(?:10|11)/);
  } finally {
    await server.close();
  }
});

test("the API rejects excess concurrent preflight requests instead of queueing unbounded work", async () => {
  let release;
  let markEntered;
  const entered = new Promise((resolve) => { markEntered = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  let quotaCalls = 0;
  const app = createPromiseBondApp({
    getRepository: async () => ({
      async consumeEvidencePreflightQuota() {
        quotaCalls += 1;
        return { allowed: true };
      }
    }),
    getReadClient: async () => ({}),
    maxConcurrentEvidencePreflights: 1,
    preflightEvidence: async () => {
      markEntered();
      await gate;
      return { passed: true, sources: [] };
    },
    logger: { error() {} }
  });
  const server = await listen(app);
  try {
    const firstPromise = fetch(`${server.baseUrl}/api/promisebond/evidence/preflight`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input())
    });
    await entered;
    const excess = await fetch(`${server.baseUrl}/api/promisebond/evidence/preflight`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input())
    });
    assert.equal(excess.status, 503);
    assert.equal((await excess.json()).error.code, "EVIDENCE_PREFLIGHT_BUSY");
    assert.equal(quotaCalls, 1);
    release();
    assert.equal((await firstPromise).status, 200);
  } finally {
    release();
    await server.close();
  }
});

test("the API fails closed on quota persistence errors and returns 429 before outbound work on exhaustion", async (t) => {
  async function exercise({ getRepository, expectedCode, expectedStatus, quotaConfig = {}, expectedRetryAfter }) {
    let outboundCalls = 0;
    const app = createPromiseBondApp({
      getRepository,
      getReadClient: async () => ({}),
      now: () => Date.parse("2026-08-10T12:00:20.000Z"),
      preflightEvidence: async () => {
        outboundCalls += 1;
        return { passed: true, sources: [] };
      },
      logger: { error() {} },
      ...quotaConfig
    });
    const server = await listen(app);
    try {
      const response = await fetch(`${server.baseUrl}/api/promisebond/evidence/preflight`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input())
      });
      assert.equal(response.status, expectedStatus);
      assert.equal((await response.json()).error.code, expectedCode);
      assert.equal(outboundCalls, 0);
      if (expectedRetryAfter !== undefined) {
        assert.equal(response.headers.get("retry-after"), expectedRetryAfter);
      }
    } finally {
      await server.close();
    }
  }

  await t.test("database unavailable", () => exercise({
    getRepository: async () => undefined,
    expectedCode: "DATABASE_UNAVAILABLE",
    expectedStatus: 503
  }));

  await t.test("atomic quota operation failed", () => exercise({
    getRepository: async () => ({
      async consumeEvidencePreflightQuota() {
        throw new Error("database write failed with mongodb://secret");
      }
    }),
    expectedCode: "EVIDENCE_QUOTA_UNAVAILABLE",
    expectedStatus: 503
  }));

  let deniedInput;
  await t.test("distributed quota exhausted", () => exercise({
    getRepository: async () => ({
      async consumeEvidencePreflightQuota(value) {
        deniedInput = value;
        return { allowed: false, scope: "client", resetAt: new Date("2026-08-10T12:01:00.000Z") };
      }
    }),
    expectedCode: "EVIDENCE_PREFLIGHT_QUOTA_EXCEEDED",
    expectedStatus: 429,
    expectedRetryAfter: "40",
    quotaConfig: {
      evidencePreflightQuotaWindowMs: 120_000,
      evidencePreflightGlobalSourceLimit: 9,
      evidencePreflightClientSourceLimit: 3
    }
  }));
  assert.equal(deniedInput.windowMs, 120_000);
  assert.equal(deniedInput.globalLimit, 9);
  assert.equal(deniedInput.clientLimit, 3);
  assert.equal(deniedInput.cost, 3);
});
