import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const distributionPath = path.join(rootPath, "dist");
const forbiddenFilePattern = /(backit|privy|battlespage|adminconsolepage)/i;
const forbiddenContentPatterns = [
  /\bBackIt\b/i,
  /@privy-io/i,
  /PrivyAuthProvider/i,
  /BattlesPage/,
  /AdminConsolePage/
];
const textExtensions = new Set([".css", ".html", ".js", ".json", ".map", ".svg"]);

function listFiles(directory) {
  return readdirSync(directory).flatMap((entry) => {
    const entryPath = path.join(directory, entry);
    return statSync(entryPath).isDirectory() ? listFiles(entryPath) : [entryPath];
  });
}

const files = listFiles(distributionPath);
const failures = [];

for (const file of files) {
  const relativePath = path.relative(distributionPath, file).replaceAll("\\", "/");
  if (forbiddenFilePattern.test(relativePath)) {
    failures.push(`forbidden artifact name: ${relativePath}`);
  }

  if (!textExtensions.has(path.extname(file))) continue;
  const contents = readFileSync(file, "utf8");
  for (const pattern of forbiddenContentPatterns) {
    if (pattern.test(contents)) failures.push(`forbidden BackIt/Privy content in ${relativePath}`);
  }
}

const indexHtml = readFileSync(path.join(distributionPath, "index.html"), "utf8");
if (!indexHtml.includes("PromiseBond")) failures.push("PromiseBond metadata is missing from index.html");

const distributionFiles = new Set(
  files.map((file) => path.relative(distributionPath, file).replaceAll("\\", "/"))
);
const socialImagePaths = Array.from(indexHtml.matchAll(
  /<meta (?:property="og:image"|name="twitter:image") content="([^"]+)" \/>/g
)).map((match) => match[1]).filter((value) => value.startsWith("/"));

for (const imagePath of socialImagePaths) {
  if (!distributionFiles.has(imagePath.slice(1))) {
    failures.push(`social image metadata references a missing asset: ${imagePath}`);
  }
}
if (distributionFiles.has("og.png") && !socialImagePaths.includes("/og.png")) {
  failures.push("unreferenced PromiseBond public asset og.png is still shipped");
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`[FAIL] ${failure}`);
  process.exitCode = 1;
} else {
  console.log(`PromiseBond artifact isolation passed (${files.length} files; no BackIt or Privy assets).`);
}
