import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";

import handler, { stripVercelRewritePathQuery } from "../../api/promisebond.js";
import { parsePublicListQuery } from "../../server/promisebond/validation.js";

const CREATOR = "0x2000000000000000000000000000000000000002";

test("Vercel adapter removes one internal path capture and preserves creator list query bytes", () => {
  const requestUrl =
    `/api/promisebond/contracts?__promisebond_path=contracts&creator=${CREATOR}&limit=10`;
  assert.equal(
    stripVercelRewritePathQuery(requestUrl, { isVercel: true }),
    `/api/promisebond/contracts?creator=${CREATOR}&limit=10`
  );
  assert.equal(stripVercelRewritePathQuery(requestUrl, { isVercel: false }), requestUrl);
});

test("Vercel adapter never hides a caller-supplied path query", () => {
  assert.equal(
    stripVercelRewritePathQuery(
      `/api/promisebond/contracts?__promisebond_path=contracts&path=caller&creator=${CREATOR}`,
      { isVercel: true }
    ),
    `/api/promisebond/contracts?path=caller&creator=${CREATOR}`
  );
  assert.equal(
    stripVercelRewritePathQuery(
      `/api/promisebond/contracts?__promisebond_path=contracts&__promisebond_path=caller&creator=${CREATOR}`,
      { isVercel: true }
    ),
    `/api/promisebond/contracts?__promisebond_path=caller&creator=${CREATOR}`
  );
  assert.equal(
    stripVercelRewritePathQuery(
      `/api/promisebond/contracts?path=caller&creator=${CREATOR}`,
      { isVercel: true }
    ),
    `/api/promisebond/contracts?path=caller&creator=${CREATOR}`
  );
});

test("Vercel adapter handles exact, nested, and generic API rewrite captures only", () => {
  assert.equal(
    stripVercelRewritePathQuery("/api/promisebond?__promisebond_path=", { isVercel: true }),
    "/api/promisebond"
  );
  assert.equal(
    stripVercelRewritePathQuery(
      "/api/promisebond/health?__promisebond_path=health",
      { isVercel: true }
    ),
    "/api/promisebond/health"
  );
  assert.equal(
    stripVercelRewritePathQuery("/api/index?__promisebond_path=index", { isVercel: true }),
    "/api/index?__promisebond_path=index"
  );
  assert.equal(
    stripVercelRewritePathQuery("/other?path=other", { isVercel: true }),
    "/other?path=other"
  );
});

test("wrapped creator list request passes strict query validation after platform cleanup", async () => {
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address();
    const response = await fetch(
      `http://127.0.0.1:${address.port}/api/promisebond/contracts` +
        `?__promisebond_path=contracts&creator=${CREATOR}&limit=10`
    );
    const payload = await response.json();
    assert.equal(response.status, 503);
    assert.equal(payload.error?.code, "DATABASE_UNAVAILABLE");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("creator list accepts only the exact Vercel transport route metadata", () => {
  assert.deepEqual(
    parsePublicListQuery({
      __promisebond_path: "contracts",
      creator: CREATOR,
      limit: "10"
    }),
    { creator: CREATOR, cursor: null, limit: 10 }
  );
  assert.throws(
    () => parsePublicListQuery({ __promisebond_path: "other", creator: CREATOR }),
    /route metadata is invalid/
  );
  assert.throws(
    () => parsePublicListQuery({ __promisebond_path: ["contracts"], creator: CREATOR }),
    /route metadata is invalid/
  );
});
