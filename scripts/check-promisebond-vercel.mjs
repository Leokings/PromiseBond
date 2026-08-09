import assert from "node:assert/strict";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const smokeCreator = "0x2000000000000000000000000000000000000002";
const configPath = path.join(root, "vercel.json");
const configSource = await readFile(configPath, "utf8");
const config = JSON.parse(configSource);

assert.equal(config.buildCommand, "npm run build:promisebond");
assert.deepEqual(
  config.builds.map(({ src }) => src).sort(),
  ["api/promisebond.js", "config/promisebond/vercel-build/package.json"],
  "legacy builds must remain a strict output allowlist"
);
const staticBuild = config.builds.find(({ src }) => (
  src === "config/promisebond/vercel-build/package.json"
));
assert.equal(staticBuild?.config?.distDir, "../../../dist");
assert.equal(staticBuild?.config?.routePrefix, "/");
assert.equal(
  config.builds.find(({ src }) => src === "api/promisebond.js")?.use,
  "@vercel/node"
);
assert.deepEqual(
  config.builds.find(({ src }) => src === "api/promisebond.js")?.config?.excludeFiles,
  ["config/promisebond/**"],
  "local PromiseBond env files must never be traced into the function bundle"
);
assert.ok(
  config.rewrites.some(({ source, destination }) => (
    source === "/api/promisebond/:__promisebond_path*" && destination === "/api/promisebond.js"
  )),
  "PromiseBond nested API routes must reach the single serverless function"
);
assert.deepEqual(
  config.rewrites,
  [
    {
      source: "/api/promisebond/:__promisebond_path*",
      destination: "/api/promisebond.js"
    },
    {
      source: "/:path((?!api(?:/|$)).*)",
      destination: "/index.html"
    }
  ],
  "only PromiseBond may be rewritten into the API function and the SPA fallback must exclude /api"
);
assert.ok(
  config.crons.every(({ path: cronPath }) => cronPath.startsWith("/api/promisebond/")),
  "only PromiseBond cron routes are allowed"
);
assert.doesNotMatch(configSource, /BackIt|BackItBattle|Privy|Base Sepolia|USDC/i);

const buildPackage = JSON.parse(await readFile(
  path.join(root, "config", "promisebond", "vercel-build", "package.json"),
  "utf8"
));
assert.equal(buildPackage.scripts?.build, "node ../../../scripts/build-promisebond-vercel.mjs");
const buildScript = await readFile(path.join(root, "scripts", "build-promisebond-vercel.mjs"), "utf8");
assert.match(buildScript, /\["run", "build:promisebond"\]/);
assert.doesNotMatch(buildScript, /\["run", "build"\]/);

async function listFiles(directory) {
  const entries = await readdir(directory);
  return (await Promise.all(entries.map(async (entry) => {
    const entryPath = path.join(directory, entry);
    return (await stat(entryPath)).isDirectory()
      ? listFiles(entryPath)
      : [entryPath];
  }))).flat();
}

const outputFlag = process.argv.indexOf("--output");
if (outputFlag >= 0) {
  const outputArgument = process.argv[outputFlag + 1];
  assert.ok(outputArgument && !outputArgument.startsWith("--"), "--output requires a directory");
  const outputDirectory = path.resolve(root, outputArgument);
  const functionRoot = path.join(outputDirectory, "functions", "api");
  assert.deepEqual(
    (await readdir(functionRoot)).sort(),
    ["promisebond.js.func"],
    "the deployment may contain only the PromiseBond function"
  );
  const bundledFiles = await listFiles(path.join(functionRoot, "promisebond.js.func"));
  const bundledRelativePaths = bundledFiles.map((file) => (
    path.relative(outputDirectory, file).replaceAll("\\", "/")
  ));
  assert.ok(
    bundledRelativePaths.every((file) => !/(^|\/)\.env(?:\.|$)/i.test(file)),
    "environment files must never be bundled"
  );
  assert.ok(
    bundledRelativePaths.every((file) => !/backit|privy/i.test(file)),
    "BackIt and Privy files must never be bundled"
  );
  const builtConfig = JSON.parse(await readFile(path.join(outputDirectory, "config.json"), "utf8"));
  assert.deepEqual(builtConfig.crons, config.crons);
  const destinationRoutes = builtConfig.routes.filter(({ dest }) => typeof dest === "string");
  const apiRoutes = destinationRoutes.filter(({ dest }) => dest.startsWith("/api/promisebond.js"));
  assert.equal(apiRoutes.length, 1, "exactly one PromiseBond API rewrite may target the function");
  assert.ok(
    apiRoutes.every(({ dest }) => dest.split("?", 1)[0] === "/api/promisebond.js"),
    "compiled API destinations must resolve to api/promisebond.js.func"
  );
  assert.ok(
    apiRoutes.every(({ dest }) => dest === "/api/promisebond.js?__promisebond_path=$1"),
    "compiled API route must use only the reserved PromiseBond transport query key"
  );
  const spaRouteIndex = builtConfig.routes.findIndex(({ dest }) => (
    typeof dest === "string" && dest.split("?", 1)[0] === "/index.html"
  ));
  assert.ok(spaRouteIndex >= 0, "compiled SPA fallback is missing");
  assert.ok(
    apiRoutes.every((route) => builtConfig.routes.indexOf(route) < spaRouteIndex),
    "API rewrites must run before the SPA fallback"
  );
  const [promiseBondRoute] = apiRoutes;
  assert.match("/api/promisebond", new RegExp(promiseBondRoute.src));
  assert.match("/api/promisebond/health", new RegExp(promiseBondRoute.src));
  assert.doesNotMatch("/api/index", new RegExp(promiseBondRoute.src));
  const spaRoute = builtConfig.routes[spaRouteIndex];
  const spaRegex = new RegExp(spaRoute.src);
  for (const apiPath of ["/api", "/api/", "/api/index", "/api/promisebondish"]) {
    assert.doesNotMatch(apiPath, spaRegex, `SPA fallback must not match ${apiPath}`);
  }
  for (const spaPath of ["/", "/about", "/promises/example"]) {
    assert.match(spaPath, spaRegex, `SPA fallback must match ${spaPath}`);
  }
}

const adapter = await import(new URL("../api/promisebond.js", import.meta.url));
assert.equal(typeof adapter.default, "function", "PromiseBond Vercel adapter must export a handler");
assert.equal(adapter.config?.maxDuration, 300);

const remoteUrl = process.argv.slice(2).find((argument, index, arguments_) => (
  !argument.startsWith("--") && arguments_[index - 1] !== "--output"
));
if (remoteUrl) {
  const origin = new URL(remoteUrl).origin;
  const [home, apiRoot, creatorList, health, forbiddenApi] = await Promise.all([
    fetch(`${origin}/`, { redirect: "error" }),
    fetch(`${origin}/api/promisebond`, { redirect: "error" }),
    fetch(
      `${origin}/api/promisebond/contracts?creator=${smokeCreator}&limit=1`,
      { redirect: "error" }
    ),
    fetch(`${origin}/api/promisebond/health`, { redirect: "error" }),
    fetch(`${origin}/api/index`, { redirect: "error" })
  ]);
  const homeText = await home.text();
  assert.equal(home.status, 200);
  assert.match(homeText, /PromiseBond/i);
  assert.doesNotMatch(homeText, /BackIt|Privy/i);
  assert.equal(apiRoot.status, 404);
  assert.match(apiRoot.headers.get("content-type") || "", /^application\/json\b/i);
  assert.equal((await apiRoot.json()).error?.code, "NOT_FOUND");
  assert.equal(creatorList.status, 200, "creator list query must survive Vercel path rewriting");
  assert.match(creatorList.headers.get("content-type") || "", /^application\/json\b/i);
  assert.ok(Array.isArray((await creatorList.json()).items));
  assert.ok([200, 503].includes(health.status), `unexpected health status ${health.status}`);
  assert.match(health.headers.get("content-type") || "", /^application\/json\b/i);
  assert.equal(forbiddenApi.status, 404, "non-PromiseBond API routes must not be exposed");
  assert.doesNotMatch(await forbiddenApi.text(), /BackIt/i);
}

console.log(remoteUrl
  ? "PromiseBond Vercel config and deployed isolation checks passed."
  : "PromiseBond Vercel config and adapter isolation checks passed.");
