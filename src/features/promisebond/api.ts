import { getAddress, type Address } from "viem";

const PROMISEBOND_SOURCE_KECCAK256 =
  "0xea739a4cc74438ffebb4656fd2ebc39d2a1df2239a6a9722ac227009c0488ea1";
const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
const DECIMAL_PATTERN = /^(?:0|[1-9][0-9]*)$/;
const REQUEST_TIMEOUT_MS = 40_000;

type PromiseBondApiTerms = {
  beneficiary: Address;
  bondAmountWei: string;
  creator: Address;
  deadline: string;
  evidenceUrlsJson: string;
  failureCriteria: string;
  fundingDeadline: string;
  policyVersion: "promisebond.native-gen.v1";
  promiseText: string;
  successCriteria: string;
};

export type PromiseBondApiBond = {
  beneficiaryAddress: Address;
  bondAmountWei: string;
  contractAddress: Address;
  creatorAddress: Address;
  deadline: string;
  fundingDeadline: string;
  network: "bradbury";
  outcome: string;
  sourceKeccak256: string;
  status: string;
  terms: PromiseBondApiTerms;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function exactAddress(value: unknown, label: string) {
  if (typeof value !== "string" || !ADDRESS_PATTERN.test(value)) {
    throw new Error(`PromiseBond API returned an invalid ${label}`);
  }
  return getAddress(value);
}

function exactDecimal(value: unknown, label: string) {
  if (typeof value !== "string" || !DECIMAL_PATTERN.test(value)) {
    throw new Error(`PromiseBond API returned an invalid ${label}`);
  }
  return value;
}

function exactString(value: unknown, label: string) {
  if (typeof value !== "string") throw new Error(`PromiseBond API returned an invalid ${label}`);
  return value;
}

function parseBond(value: unknown): PromiseBondApiBond {
  if (!isObject(value) || !isObject(value.terms)) {
    throw new Error("PromiseBond API returned an invalid bond record");
  }
  const terms = value.terms;
  const policyVersion = exactString(terms.policyVersion, "policy version");
  if (policyVersion !== "promisebond.native-gen.v1") {
    throw new Error("PromiseBond API returned a bond from another policy release");
  }
  const sourceKeccak256 = exactString(value.sourceKeccak256, "source hash").toLowerCase();
  if (sourceKeccak256 !== PROMISEBOND_SOURCE_KECCAK256) {
    throw new Error("PromiseBond API returned a bond from another source release");
  }
  if (value.network !== "bradbury" || value.chainId !== "4221") {
    throw new Error("PromiseBond API returned a bond from another network");
  }

  const creatorAddress = exactAddress(value.creatorAddress, "creator address");
  const beneficiaryAddress = exactAddress(value.beneficiaryAddress, "beneficiary address");
  const bondAmountWei = exactDecimal(value.bondAmountWei, "bond amount");
  const fundingDeadline = exactDecimal(value.fundingDeadline, "funding deadline");
  const deadline = exactDecimal(value.deadline, "resolution deadline");
  const parsedTerms: PromiseBondApiTerms = {
    beneficiary: exactAddress(terms.beneficiary, "terms beneficiary"),
    bondAmountWei: exactDecimal(terms.bondAmountWei, "terms bond amount"),
    creator: exactAddress(terms.creator, "terms creator"),
    deadline: exactDecimal(terms.deadline, "terms resolution deadline"),
    evidenceUrlsJson: exactString(terms.evidenceUrlsJson, "evidence URLs"),
    failureCriteria: exactString(terms.failureCriteria, "failure criteria"),
    fundingDeadline: exactDecimal(terms.fundingDeadline, "terms funding deadline"),
    policyVersion,
    promiseText: exactString(terms.promiseText, "promise text"),
    successCriteria: exactString(terms.successCriteria, "success criteria")
  };
  if (
    parsedTerms.creator.toLowerCase() !== creatorAddress.toLowerCase()
    || parsedTerms.beneficiary.toLowerCase() !== beneficiaryAddress.toLowerCase()
    || parsedTerms.bondAmountWei !== bondAmountWei
    || parsedTerms.fundingDeadline !== fundingDeadline
    || parsedTerms.deadline !== deadline
  ) {
    throw new Error("PromiseBond API returned contradictory finalized terms");
  }

  return {
    beneficiaryAddress,
    bondAmountWei,
    contractAddress: exactAddress(value.contractAddress, "contract address"),
    creatorAddress,
    deadline,
    fundingDeadline,
    network: "bradbury",
    outcome: exactString(value.outcome, "outcome"),
    sourceKeccak256,
    status: exactString(value.status, "settlement status"),
    terms: parsedTerms
  };
}

async function apiFetch(path: string, init?: RequestInit) {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(path, {
      ...init,
      headers: { accept: "application/json", ...init?.headers },
      signal: controller.signal
    });
  } finally {
    window.clearTimeout(timer);
  }
}

export async function registerPromiseBondContract(contractAddress: Address) {
  const response = await apiFetch("/api/promisebond/contracts", {
    body: JSON.stringify({ contractAddress }),
    headers: { "content-type": "application/json" },
    method: "POST"
  });
  if (!response.ok) throw new Error("PromiseBond index registration is unavailable");
}

export async function listPromiseBondsForCreator(creator: Address, limit = 100) {
  const query = new URLSearchParams({ creator, limit: String(limit) });
  const response = await apiFetch(`/api/promisebond/contracts?${query}`);
  if (!response.ok) throw new Error("PromiseBond index is unavailable");
  const body: unknown = await response.json();
  if (!isObject(body) || !Array.isArray(body.items)) {
    throw new Error("PromiseBond API returned an invalid list");
  }
  return body.items.map(parseBond).filter(
    (bond) => bond.creatorAddress.toLowerCase() === creator.toLowerCase()
  );
}
