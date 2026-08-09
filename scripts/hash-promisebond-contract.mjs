import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { keccak256, stringToHex } from "viem";

const rootPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = path.join(rootPath, "contracts", "PromiseBond.py");
const source = fs.readFileSync(sourcePath, "utf8");

console.log(keccak256(stringToHex(source)));
