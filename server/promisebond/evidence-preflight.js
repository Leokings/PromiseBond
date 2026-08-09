import { createHash } from "node:crypto";
import { lookup as lookupHostname } from "node:dns/promises";
import https from "node:https";
import { isIP } from "node:net";

export const EVIDENCE_SOURCE_COUNT = 3;
export const EVIDENCE_SOURCE_TIMEOUT_MS = 8_000;
export const EVIDENCE_SOURCE_MAX_BYTES = 12_000;

const MAX_URL_BYTES = 500;
// Large, reputable anycast registries can legitimately publish more than sixteen A/AAAA
// records. Keep the set bounded while allowing the current npm registry answer (24 records).
const MAX_RESOLVED_ADDRESSES = 32;
const DEFAULT_MAX_CONCURRENCY = 2;
const SAFE_DNS_LABEL = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)$/;
const SAFE_MEDIA_TYPE = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/;
// Keep this byte-for-byte compatible with PromiseBond.py and the browser client.
const SAFE_CANONICAL_URL = /^https:\/\/[a-z0-9.-]+(?:\/[A-Za-z0-9._~!$&()*+,;=:@%\/-]*)?(?:\?[A-Za-z0-9._~!$&()*+,;=:@%/?-]*)?$/;
// Python str.strip()/str.isspace() set used by PromiseBond.py for source availability.
const PYTHON_WHITESPACE_ONLY = /^[\u0009-\u000d\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]*$/u;

export class EvidencePreflightError extends Error {
  constructor(status, code, message, options) {
    super(message, options);
    this.name = "EvidencePreflightError";
    this.status = status;
    this.code = code;
  }
}

class EvidencePreflightCancelledError extends Error {
  constructor() {
    super("evidence preflight cancelled");
    this.name = "EvidencePreflightCancelledError";
  }
}

function invalidRequest(message) {
  return new EvidencePreflightError(400, "INVALID_EVIDENCE_URLS", message);
}

function rejectedSource(code, message) {
  return new EvidencePreflightError(422, code, message);
}

function boundedInteger(value, fallback, minimum, maximum) {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum ? value : fallback;
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function parseIpv4(address) {
  if (typeof address !== "string" || !/^(?:0|[1-9][0-9]{0,2})(?:\.(?:0|[1-9][0-9]{0,2})){3}$/.test(address)) {
    return undefined;
  }
  const parts = address.split(".").map(Number);
  return parts.every((part) => part <= 255) ? parts : undefined;
}

function ipv4InCidr(parts, base, prefixLength) {
  const value = parts.reduce((result, part) => ((result * 256) + part) >>> 0, 0);
  const baseValue = base.reduce((result, part) => ((result * 256) + part) >>> 0, 0);
  const mask = prefixLength === 0 ? 0 : (0xffff_ffff << (32 - prefixLength)) >>> 0;
  return (value & mask) === (baseValue & mask);
}

function isPublicIpv4(parts) {
  const blockedRanges = [
    [[0, 0, 0, 0], 8],
    [[10, 0, 0, 0], 8],
    [[100, 64, 0, 0], 10],
    [[127, 0, 0, 0], 8],
    [[169, 254, 0, 0], 16],
    [[172, 16, 0, 0], 12],
    [[192, 0, 0, 0], 24],
    [[192, 0, 2, 0], 24],
    [[192, 88, 99, 0], 24],
    [[192, 168, 0, 0], 16],
    [[198, 18, 0, 0], 15],
    [[198, 51, 100, 0], 24],
    [[203, 0, 113, 0], 24],
    [[224, 0, 0, 0], 4],
    [[240, 0, 0, 0], 4]
  ];
  return !blockedRanges.some(([base, prefixLength]) => ipv4InCidr(parts, base, prefixLength));
}

function parseIpv6(address) {
  if (typeof address !== "string") return undefined;
  let source = address.toLowerCase();
  if (source.startsWith("[") && source.endsWith("]")) source = source.slice(1, -1);
  if (source.includes("%") || isIP(source) !== 6) return undefined;

  const ipv4Tail = /(?:^|:)((?:[0-9]{1,3}\.){3}[0-9]{1,3})$/.exec(source);
  if (ipv4Tail) {
    const parts = parseIpv4(ipv4Tail[1]);
    if (!parts) return undefined;
    const replacement = `${((parts[0] << 8) | parts[1]).toString(16)}:${((parts[2] << 8) | parts[3]).toString(16)}`;
    source = `${source.slice(0, ipv4Tail.index + (source[ipv4Tail.index] === ":" ? 1 : 0))}${replacement}`;
  }

  const halves = source.split("::");
  if (halves.length > 2) return undefined;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  if ([...left, ...right].some((part) => !/^[0-9a-f]{1,4}$/.test(part))) return undefined;
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) return undefined;
  const words = [...left, ...Array(missing).fill("0"), ...right].map((part) => Number.parseInt(part, 16));
  if (words.length !== 8) return undefined;
  const bytes = Buffer.allocUnsafe(16);
  words.forEach((word, index) => bytes.writeUInt16BE(word, index * 2));
  return bytes;
}

function ipv6InCidr(bytes, base, prefixLength) {
  const baseBytes = parseIpv6(base);
  if (!baseBytes) throw new TypeError("invalid internal IPv6 CIDR base");
  const fullBytes = Math.floor(prefixLength / 8);
  const remainingBits = prefixLength % 8;
  for (let index = 0; index < fullBytes; index += 1) {
    if (bytes[index] !== baseBytes[index]) return false;
  }
  if (remainingBits === 0) return true;
  const mask = (0xff << (8 - remainingBits)) & 0xff;
  return (bytes[fullBytes] & mask) === (baseBytes[fullBytes] & mask);
}

function mappedIpv4(bytes) {
  if (!bytes.subarray(0, 10).every((byte) => byte === 0) || bytes[10] !== 0xff || bytes[11] !== 0xff) {
    return undefined;
  }
  return [...bytes.subarray(12, 16)];
}

function isPublicIpv6(bytes) {
  const mapped = mappedIpv4(bytes);
  if (mapped) return isPublicIpv4(mapped);
  if (!ipv6InCidr(bytes, "2000::", 3)) return false;
  return ![
    ["2001::", 23],
    ["2001:db8::", 32],
    ["2002::", 16],
    ["3fff::", 20]
  ].some(([base, prefixLength]) => ipv6InCidr(bytes, base, prefixLength));
}

export function isPublicEvidenceAddress(address) {
  const ipv4 = parseIpv4(address);
  if (ipv4) return isPublicIpv4(ipv4);
  const ipv6 = parseIpv6(address);
  return Boolean(ipv6 && isPublicIpv6(ipv6));
}

function addressIdentity(address) {
  const ipv4 = parseIpv4(address);
  if (ipv4) return `4:${ipv4.join(".")}`;
  const ipv6 = parseIpv6(address);
  if (!ipv6) return undefined;
  const mapped = mappedIpv4(ipv6);
  return mapped ? `4:${mapped.join(".")}` : `6:${ipv6.toString("hex")}`;
}

function hostnameFromUrl(url) {
  return url.hostname.startsWith("[") && url.hostname.endsWith("]")
    ? url.hostname.slice(1, -1)
    : url.hostname;
}

function validateDnsHostname(hostname) {
  if (hostname.length > 253 || hostname.endsWith(".")) return false;
  const labels = hostname.split(".");
  return labels.length >= 2 && labels.every((label) => SAFE_DNS_LABEL.test(label));
}

function canonicalizeUrl(raw) {
  if (typeof raw !== "string") throw invalidRequest("Evidence URLs must be strings");
  if (Buffer.byteLength(raw, "utf8") > MAX_URL_BYTES) {
    throw invalidRequest("Evidence URLs cannot exceed 500 UTF-8 bytes");
  }
  if (!/^[\x20-\x7e]+$/.test(raw) || raw.includes("\\")) {
    throw invalidRequest("Evidence URLs must use canonical ASCII URL syntax");
  }
  if (/%(?![0-9a-fA-F]{2})/.test(raw)) {
    throw invalidRequest("Evidence URLs must use valid percent escapes");
  }
  if (raw.endsWith("?") || raw.includes("#")) {
    throw invalidRequest("Evidence URLs must not contain empty queries or fragments");
  }
  if (/\/(?:\.|%2e)(?:\.|%2e)?(?:\/|[?#]|$)/i.test(raw)) {
    throw invalidRequest("Evidence URLs must not contain dot path segments");
  }

  let url;
  try {
    url = new URL(raw);
  } catch {
    throw invalidRequest("Every evidence source must be a valid HTTPS URL");
  }
  const rawAuthority = raw.slice("https://".length).split(/[/?#]/, 1)[0];
  if (
    url.protocol !== "https:" || !raw.startsWith("https://") || !url.hostname ||
    rawAuthority.includes("@") || url.username || url.password || url.hash ||
    (url.port && url.port !== "443")
  ) {
    throw invalidRequest("Evidence URLs must be canonical HTTPS URLs without credentials, fragments, or non-443 ports");
  }

  const hostname = hostnameFromUrl(url).toLowerCase();
  const hostnameIpFamily = isIP(hostname);
  if (hostnameIpFamily === 6) {
    throw invalidRequest("Evidence URLs must use DNS hostnames or canonical IPv4 addresses");
  }
  const resemblesLegacyIpv4 = /^(?:0x[0-9a-f]+|[0-9]+)(?:\.(?:0x[0-9a-f]+|[0-9]+)){0,3}$/i.test(hostname);
  if (resemblesLegacyIpv4 && hostnameIpFamily !== 4) {
    throw invalidRequest("Evidence URLs must use canonical four-octet IPv4 syntax");
  }
  if (hostnameIpFamily === 0 && !validateDnsHostname(hostname)) {
    throw invalidRequest("Evidence URLs must use a canonical DNS hostname or IP address");
  }
  if (
    hostname === "localhost" || hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") || hostname.endsWith(".internal") ||
    hostname === "metadata.google.internal"
  ) {
    throw invalidRequest("Evidence URLs must not target local hostnames");
  }
  if (hostnameIpFamily !== 0 && !isPublicEvidenceAddress(hostname)) {
    throw invalidRequest("Evidence URLs must not target non-public IP addresses");
  }

  const canonical = url.href.replace(/%[0-9a-fA-F]{2}/g, (escape) => escape.toUpperCase());
  if (canonical !== raw || !SAFE_CANONICAL_URL.test(canonical)) {
    throw invalidRequest("Evidence URLs must already use the canonical PromiseBond URL grammar");
  }
  const authority = hostnameIpFamily === 4
    ? hostname
    : hostname.split(".").slice(-2).join(".");
  return Object.freeze({ raw, url, hostname, authority });
}

export function validateEvidencePreflightInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw invalidRequest("Request body must be an object containing exactly three evidence URLs");
  }
  const keys = Object.keys(input);
  if (keys.length !== 1 || keys[0] !== "urls" || !hasOwn(input, "urls") || !Array.isArray(input.urls)) {
    throw invalidRequest("Request body must contain only the urls array");
  }
  if (input.urls.length !== EVIDENCE_SOURCE_COUNT) {
    throw invalidRequest("Exactly three evidence URLs are required");
  }
  const sources = input.urls.map(canonicalizeUrl);
  if (new Set(sources.map(({ raw }) => raw)).size !== EVIDENCE_SOURCE_COUNT) {
    throw invalidRequest("Evidence URLs must not contain duplicates");
  }
  if (new Set(sources.map(({ authority }) => authority)).size !== EVIDENCE_SOURCE_COUNT) {
    throw invalidRequest("Evidence URLs must use three distinct host authorities");
  }
  return sources;
}

async function defaultResolveHostname(hostname) {
  const family = isIP(hostname);
  if (family !== 0) return [{ address: hostname, family }];
  return lookupHostname(hostname, { all: true, verbatim: true });
}

function normalizeResolvedAddresses(records) {
  if (!Array.isArray(records) || records.length === 0 || records.length > MAX_RESOLVED_ADDRESSES) {
    throw rejectedSource("EVIDENCE_DNS_REJECTED", "An evidence hostname did not resolve to a bounded public address set");
  }
  const unique = new Map();
  for (const record of records) {
    const address = typeof record === "string" ? record : record?.address;
    const actualFamily = isIP(address);
    const family = typeof record === "object" && record !== null ? Number(record.family) : actualFamily;
    const identity = addressIdentity(address);
    if (!identity || family !== actualFamily || !isPublicEvidenceAddress(address)) {
      throw rejectedSource("EVIDENCE_DNS_REJECTED", "An evidence hostname resolved to a non-public address");
    }
    if (!unique.has(identity)) unique.set(identity, Object.freeze({ address, family, identity }));
  }
  return [...unique.values()];
}

function assertConnectedAddress(address, allowedIdentities) {
  const identity = addressIdentity(address);
  if (!identity || !isPublicEvidenceAddress(address) || !allowedIdentities.has(identity)) {
    throw rejectedSource("EVIDENCE_CONNECTION_REJECTED", "An evidence connection did not use its validated public address set");
  }
}

function defaultFetchSource({ url, addresses, signal }) {
  return new Promise((resolve, reject) => {
    const allowedIdentities = new Set(addresses.map(({ identity }) => identity));
    let settled = false;
    const finishReject = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const request = https.request(url, {
      method: "GET",
      agent: false,
      headers: { "accept-encoding": "identity" },
      signal,
      autoSelectFamily: true,
      autoSelectFamilyAttemptTimeout: 250,
      lookup(_hostname, options, callback) {
        const requestedFamily = typeof options === "object" ? Number(options.family || 0) : Number(options || 0);
        const candidates = requestedFamily === 4 || requestedFamily === 6
          ? addresses.filter(({ family }) => family === requestedFamily)
          : addresses;
        if (candidates.length === 0) {
          callback(Object.assign(new Error("validated DNS family unavailable"), { code: "ENOTFOUND" }));
          return;
        }
        if (typeof options === "object" && options.all === true) {
          callback(null, candidates.map(({ address, family }) => ({ address, family })));
          return;
        }
        callback(null, candidates[0].address, candidates[0].family);
      }
    }, (response) => {
      try {
        assertConnectedAddress(response.socket?.remoteAddress, allowedIdentities);
      } catch (error) {
        response.destroy(error);
        finishReject(error);
        return;
      }
      if (settled) {
        response.destroy();
        return;
      }
      settled = true;
      resolve({
        status: response.statusCode,
        headers: response.headers,
        body: response,
        remoteAddress: response.socket.remoteAddress
      });
    });
    request.once("socket", (socket) => {
      socket.on("connectionAttempt", (address) => {
        try {
          assertConnectedAddress(address, allowedIdentities);
        } catch (error) {
          socket.destroy(error);
        }
      });
      socket.once("secureConnect", () => {
        try {
          assertConnectedAddress(socket.remoteAddress, allowedIdentities);
        } catch (error) {
          socket.destroy(error);
        }
      });
    });
    request.once("error", finishReject);
    request.end();
  });
}

function responseHeader(headers, name) {
  if (headers && typeof headers.get === "function") return headers.get(name);
  if (!headers || typeof headers !== "object") return undefined;
  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === name);
  return Array.isArray(entry?.[1]) ? entry[1][0] : entry?.[1];
}

function canonicalContentType(response) {
  const header = responseHeader(response.headers, "content-type");
  if (typeof header !== "string") {
    throw rejectedSource("EVIDENCE_CONTENT_TYPE_REJECTED", "An evidence source did not return an allowed Content-Type");
  }
  const mediaType = header.split(";", 1)[0].trim().toLowerCase();
  const allowed = mediaType === "text/plain" || mediaType === "text/html" ||
    mediaType === "application/json" || (SAFE_MEDIA_TYPE.test(mediaType) && mediaType.endsWith("+json"));
  if (!allowed) {
    throw rejectedSource("EVIDENCE_CONTENT_TYPE_REJECTED", "An evidence source did not return an allowed Content-Type");
  }
  return mediaType;
}

function assertIdentityContentEncoding(response) {
  const header = responseHeader(response.headers, "content-encoding");
  if (header === undefined || header === null || header === "") return;
  if (typeof header !== "string" || header.trim().toLowerCase() !== "identity") {
    throw rejectedSource(
      "EVIDENCE_CONTENT_ENCODING_REJECTED",
      "Compressed evidence responses are not allowed"
    );
  }
}

function destroyResponseBody(response, error) {
  const body = response?.body;
  if (body && typeof body.destroy === "function") body.destroy(error);
  else if (body && typeof body.cancel === "function") void body.cancel(error).catch?.(() => {});
}

async function digestResponse(response, maxBytes) {
  const declaredLength = responseHeader(response.headers, "content-length");
  if (typeof declaredLength === "string" && /^[0-9]+$/.test(declaredLength) && Number(declaredLength) > maxBytes) {
    destroyResponseBody(response);
    throw rejectedSource("EVIDENCE_TOO_LARGE", "An evidence source exceeded the 12000-byte limit");
  }
  const hash = createHash("sha256");
  const chunks = [];
  let bytes = 0;
  try {
    if (response.body) {
      for await (const value of response.body) {
        const chunk = typeof value === "string" ? Buffer.from(value, "utf8") : Buffer.from(value);
        bytes += chunk.byteLength;
        if (bytes > maxBytes) {
          throw rejectedSource("EVIDENCE_TOO_LARGE", "An evidence source exceeded the 12000-byte limit");
        }
        chunks.push(chunk);
        hash.update(chunk);
      }
    }
  } catch (error) {
    destroyResponseBody(response, error);
    throw error;
  }
  if (bytes === 0) {
    throw rejectedSource("EVIDENCE_EMPTY", "An evidence source returned an empty body");
  }
  if (PYTHON_WHITESPACE_ONLY.test(Buffer.concat(chunks, bytes).toString("utf8"))) {
    throw rejectedSource("EVIDENCE_EMPTY", "An evidence source returned an empty body");
  }
  return { bytes, sha256: hash.digest("hex") };
}

function runWithTimeout(work, milliseconds, parentSignal) {
  const controller = new AbortController();
  let timer;
  let removeParentListener = () => {};
  const cancelled = new Promise((_, reject) => {
    const cancel = () => {
      reject(new EvidencePreflightCancelledError());
      controller.abort();
    };
    if (parentSignal.aborted) {
      cancel();
      return;
    }
    parentSignal.addEventListener("abort", cancel, { once: true });
    removeParentListener = () => parentSignal.removeEventListener("abort", cancel);
  });
  const timedOut = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new EvidencePreflightError(504, "EVIDENCE_SOURCE_TIMEOUT", "An evidence source exceeded the 8-second timeout"));
      controller.abort();
    }, milliseconds);
  });
  return Promise.race([Promise.resolve().then(() => work(controller.signal)), timedOut, cancelled])
    .finally(() => {
      clearTimeout(timer);
      removeParentListener();
    });
}

function normalizeUnexpectedError(error) {
  if (error instanceof EvidencePreflightError || error instanceof EvidencePreflightCancelledError) return error;
  return rejectedSource("EVIDENCE_SOURCE_UNAVAILABLE", "An evidence source could not be fetched securely");
}

async function checkSource(source, {
  resolveHostname,
  fetchSource,
  timeoutMs,
  maxBytes,
  parentSignal
}) {
  try {
    return await runWithTimeout(async (signal) => {
      const addresses = normalizeResolvedAddresses(await resolveHostname(source.hostname, { signal }));
      const response = await fetchSource({
        url: source.url,
        addresses,
        signal
      });
      const status = Number(response?.status ?? response?.statusCode);
      if (!Number.isInteger(status) || status < 100 || status > 599) {
        destroyResponseBody(response);
        throw rejectedSource("EVIDENCE_SOURCE_REJECTED", "An evidence source returned an invalid HTTP status");
      }
      if (response.remoteAddress !== undefined) {
        try {
          assertConnectedAddress(
            response.remoteAddress,
            new Set(addresses.map(({ identity }) => identity)
          ));
        } catch (error) {
          destroyResponseBody(response);
          throw error;
        }
      }
      if (status >= 300 && status <= 399) {
        destroyResponseBody(response);
        throw rejectedSource("EVIDENCE_REDIRECT_REJECTED", "Evidence source redirects are not allowed");
      }
      if (status < 200 || status > 299) {
        destroyResponseBody(response);
        throw rejectedSource("EVIDENCE_HTTP_REJECTED", "An evidence source did not return a successful HTTP status");
      }
      let contentType;
      try {
        assertIdentityContentEncoding(response);
        contentType = canonicalContentType(response);
      } catch (error) {
        destroyResponseBody(response);
        throw error;
      }
      const { bytes, sha256 } = await digestResponse(response, maxBytes);
      return Object.freeze({
        url: source.raw,
        status,
        contentType,
        bytes,
        sha256,
        pass: true
      });
    }, timeoutMs, parentSignal);
  } catch (error) {
    throw normalizeUnexpectedError(error);
  }
}

async function mapSources(sources, concurrency, mapper) {
  const results = new Array(sources.length);
  const controller = new AbortController();
  let cursor = 0;
  let failure;
  const workers = Array.from({ length: Math.min(concurrency, sources.length) }, async () => {
    while (!failure) {
      const index = cursor;
      cursor += 1;
      if (index >= sources.length) return;
      try {
        results[index] = await mapper(sources[index], controller.signal);
      } catch (error) {
        if (!failure) {
          failure = error;
          controller.abort();
        }
      }
    }
  });
  await Promise.all(workers);
  if (failure) throw failure;
  return results;
}

export function createEvidencePreflight({
  resolveHostname = defaultResolveHostname,
  fetchSource = defaultFetchSource,
  timeoutMs = EVIDENCE_SOURCE_TIMEOUT_MS,
  maxBytes = EVIDENCE_SOURCE_MAX_BYTES,
  maxConcurrency = DEFAULT_MAX_CONCURRENCY
} = {}) {
  if (typeof resolveHostname !== "function") throw new TypeError("resolveHostname must be a function");
  if (typeof fetchSource !== "function") throw new TypeError("fetchSource must be a function");
  const boundedTimeout = boundedInteger(timeoutMs, EVIDENCE_SOURCE_TIMEOUT_MS, 1, EVIDENCE_SOURCE_TIMEOUT_MS);
  const boundedMaxBytes = boundedInteger(maxBytes, EVIDENCE_SOURCE_MAX_BYTES, 1, EVIDENCE_SOURCE_MAX_BYTES);
  const boundedConcurrency = boundedInteger(maxConcurrency, DEFAULT_MAX_CONCURRENCY, 1, EVIDENCE_SOURCE_COUNT);

  return async function preflightEvidence(input) {
    const sources = validateEvidencePreflightInput(input);
    const checked = await mapSources(sources, boundedConcurrency, (source, parentSignal) => checkSource(source, {
      resolveHostname,
      fetchSource,
      timeoutMs: boundedTimeout,
      maxBytes: boundedMaxBytes,
      parentSignal
    }));
    return Object.freeze({ passed: true, sources: Object.freeze(checked) });
  };
}

export const preflightEvidence = createEvidencePreflight();
