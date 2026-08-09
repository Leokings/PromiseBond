import app from "../server/promisebond/runtime.js";

function safelyDecodeQueryComponent(value) {
  try {
    return decodeURIComponent(value.replaceAll("+", " "));
  } catch {
    return undefined;
  }
}

const VERCEL_ROUTE_QUERY_KEY = "__promisebond_path";

/**
 * High-level Vercel rewrites append their named route capture to the destination query.
 * Remove exactly one reserved platform value without normalizing or reserializing any genuine
 * query parameter. A caller-supplied duplicate remains present and strict validation rejects it.
 */
export function stripVercelRewritePathQuery(requestUrl, { isVercel = process.env.VERCEL === "1" } = {}) {
  if (!isVercel || typeof requestUrl !== "string") return requestUrl;
  const queryIndex = requestUrl.indexOf("?");
  if (queryIndex < 0) return requestUrl;

  const fragmentIndex = requestUrl.indexOf("#", queryIndex + 1);
  const pathname = requestUrl.slice(0, queryIndex);
  const rawQuery = requestUrl.slice(queryIndex + 1, fragmentIndex < 0 ? undefined : fragmentIndex);
  const fragment = fragmentIndex < 0 ? "" : requestUrl.slice(fragmentIndex);
  if (pathname !== "/api/promisebond" && !pathname.startsWith("/api/promisebond/")) {
    return requestUrl;
  }

  let removed = false;
  const kept = rawQuery.split("&").filter((part) => {
    if (removed || !part) return true;
    const equalsIndex = part.indexOf("=");
    const rawName = equalsIndex < 0 ? part : part.slice(0, equalsIndex);
    if (safelyDecodeQueryComponent(rawName) === VERCEL_ROUTE_QUERY_KEY) {
      removed = true;
      return false;
    }
    return true;
  });
  if (!removed) return requestUrl;
  return `${pathname}${kept.length > 0 ? `?${kept.join("&")}` : ""}${fragment}`;
}

// PromiseBond uses the full Node.js runtime for MongoDB and finalized Bradbury reads.
// This module deliberately exports only the read/index API; wallet signing stays client-side.
export const config = {
  maxDuration: 300
};

export default function promiseBondVercelHandler(req, res) {
  if (typeof req?.url === "string") {
    // This adapter is bundled only as the Vercel function entry point, so do not
    // depend on optional system-environment exposure to identify the platform.
    req.url = stripVercelRewritePathQuery(req.url, { isVercel: true });
  }
  return app(req, res);
}
