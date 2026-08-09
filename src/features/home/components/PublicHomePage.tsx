import {
  ArrowRight,
  Clock3,
  Link2,
  Network,
  ShieldCheck,
  Sparkles,
  X
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { useAccount } from "wagmi";
import { formatEther, getAddress } from "viem";
import {
  listPromiseBondsForCreator,
  preflightPromiseBondEvidence,
  registerPromiseBondContract,
  type PromiseBondApiBond,
  type PromiseBondEvidencePreflight
} from "../../promisebond/api";
import {
  deployAndFundPromiseBond,
  fundPromiseBond,
  isPromiseBondFinalizedFailure,
  isPromiseBondWalletRpcCompatibilityError,
  parseTestGenAmount,
  parseUtcDateTime,
  readFinalPromiseBond,
  reconcilePromiseBondAction,
  reconcilePromiseBondDeployment,
  reconcilePromiseBondFunding,
  repairBradburyWalletRpc,
  submitPromiseBondAction,
  type PromiseBondDeployedContract,
  type PromiseBondDeployment,
  type PromiseBondDraft as ContractDraft,
  type PromiseBondProgress,
  type PromiseBondState,
  type PromiseBondWalletProvider
} from "../../promisebond/genlayer";
import {
  assertPromiseBondPersistenceAvailable,
  createPromiseBondOperationId,
  loadPromiseBondLocalRecords,
  savePromiseBondLocalRecords,
  type PromiseBondFormSnapshot,
  type PromiseBondLocalRecord
} from "../../promisebond/local-ledger";
import { PromiseBondHeader } from "../../promisebond/components/PromiseBondHeader";
import { useModalDialog } from "../../promisebond/components/useModalDialog";
import { promiseBondChain } from "../../../providers/PromiseBondWalletProvider";

type BondDraft = PromiseBondFormSnapshot;

type PromiseBondActionName = "resolve" | "expire_unfunded" | "refund_unresolved" | "refund_stale";

type ReviewedEvidencePreflight = {
  fingerprint: string;
  result: PromiseBondEvidencePreflight;
  verifiedAt: number;
};

const EVIDENCE_PREFLIGHT_MAX_AGE_MS = 5 * 60 * 1_000;
const BYTE_COUNT_FORMATTER = new Intl.NumberFormat("en-US");

function futureUtcInput(daysFromNow: number) {
  const value = new Date(Date.now() + daysFromNow * 24 * 60 * 60 * 1_000);
  value.setUTCSeconds(0, 0);
  return value.toISOString().slice(0, 16);
}

function createInitialDraft(): BondDraft {
  return {
    beneficiary: "",
    evidenceUrls: "",
    failureCriteria: "",
    fundingDeadline: futureUtcInput(1),
    promise: "",
    resolutionDeadline: futureUtcInput(30),
    stake: "",
    successCriteria: ""
  };
}

const LINE_BREAK_PATTERN = /\r?\n/;

const PROGRESS_LABELS: Record<PromiseBondProgress, string> = {
  awaiting_deployment_signature: "Confirm contract deployment in your wallet",
  deployment_finalizing: "Deployment submitted — waiting for GenLayer finality",
  deployment_finalized: "Contract finalized on Bradbury",
  awaiting_funding_signature: "Confirm the exact GEN funding transaction",
  funding_finalizing: "Funding submitted — waiting for GenLayer finality",
  complete: "PromiseBond is funded and finalized"
};

function formatUtcDeadline(value: string) {
  return value ? `${value.replace("T", " ")} UTC` : "Not set";
}

function utcInputFromSeconds(value: string) {
  const milliseconds = Number(BigInt(value) * 1_000n);
  const date = new Date(milliseconds);
  if (!Number.isFinite(milliseconds) || !Number.isFinite(date.getTime())) {
    throw new Error("PromiseBond index returned an invalid UTC deadline");
  }
  return date.toISOString().slice(0, 16);
}

function indexedBondRecord(bond: PromiseBondApiBond): PromiseBondLocalRecord {
  const rawUrls: unknown = JSON.parse(bond.terms.evidenceUrlsJson);
  if (!Array.isArray(rawUrls) || !rawUrls.every((url) => typeof url === "string")) {
    throw new Error("PromiseBond index returned invalid evidence URLs");
  }
  const createdAt = new Date().toISOString();
  return {
    amountWei: bond.bondAmountWei,
    chainId: 4221,
    contractAddress: bond.contractAddress,
    createdAt,
    creator: bond.creatorAddress,
    draft: {
      beneficiary: bond.beneficiaryAddress,
      evidenceUrls: rawUrls.join("\n"),
      failureCriteria: bond.terms.failureCriteria,
      fundingDeadline: utcInputFromSeconds(bond.fundingDeadline),
      promise: bond.terms.promiseText,
      resolutionDeadline: utcInputFromSeconds(bond.deadline),
      stake: formatEther(BigInt(bond.bondAmountWei)),
      successCriteria: bond.terms.successCriteria
    },
    evidenceUrls: rawUrls,
    fundingDeadlineSeconds: bond.fundingDeadline,
    id: `index:${bond.contractAddress.toLowerCase()}`,
    network: "bradbury",
    resolutionDeadlineSeconds: bond.deadline,
    stage: bond.status === "UNFUNDED" ? "deployed_unfunded" : "funded",
    updatedAt: createdAt
  };
}

function syncContractToIndex(contractAddress: `0x${string}`) {
  void registerPromiseBondContract(contractAddress).catch(() => undefined);
}

function getResolutionMinimum(fundingDeadline: string) {
  const fundingTime = Date.parse(`${fundingDeadline}:00Z`);
  if (!Number.isFinite(fundingTime)) return undefined;
  return new Date(fundingTime + 60_000).toISOString().slice(0, 16);
}

function parseEvidenceUrls(value: string) {
  return value
    .split(LINE_BREAK_PATTERN)
    .map((url) => url.trim())
    .filter(Boolean);
}

function evidenceFingerprint(urls: string[]) {
  return JSON.stringify(urls);
}

function assertNewEvidencePolicy(urls: string[]) {
  if (urls.length !== 3) {
    throw new Error("Provide exactly three independent evidence URLs for a new PromiseBond");
  }
}

function formatByteCount(value: number) {
  return `${BYTE_COUNT_FORMATTER.format(value)} byte${value === 1 ? "" : "s"}`;
}

function shortTransaction(value: string) {
  return `${value.slice(0, 10)}…${value.slice(-8)}`;
}

function recordStageLabel(record: PromiseBondLocalRecord) {
  if (record.stage === "funded") return "funded";
  if (record.stage === "funding_submitted") return "funding finalizing";
  if (record.stage === "deployed_unfunded") return "unfunded";
  if (record.stage === "deployment_failed") return "deployment failed";
  if (record.stage === "deployment_submitted") return "deploy finalizing";
  return "prepared";
}

function reviewNotice(record?: PromiseBondLocalRecord) {
  if (record?.stage === "deployment_submitted") {
    return "The deployment transaction is already saved. Reconcile it before continuing; do not submit another deployment.";
  }
  if (record?.stage === "deployed_unfunded") {
    return "The contract is finalized but no GEN is locked yet. Continue only to submit the exact funding transaction shown in these terms.";
  }
  if (record?.stage === "funding_submitted") {
    return "The funding transaction is already saved. Reconcile it before continuing; do not fund this bond again.";
  }
  if (record?.stage === "funded") {
    return "This PromiseBond is funded and finalized. Its latest finalized state is available from Your PromiseBonds.";
  }
  return "Nothing moves until you continue. Your wallet will request two Bradbury transactions: deploy the immutable terms, then fund the exact GEN bond. Transaction IDs are saved before finality polling so this dialog can be closed safely.";
}

function isRecoverableRecord(record: PromiseBondLocalRecord) {
  return record.stage === "deployment_submitted"
    || record.stage === "deployed_unfunded"
    || record.stage === "funding_submitted"
    || Boolean(record.pendingAction);
}

function actionLabel(action: PromiseBondActionName) {
  if (action === "expire_unfunded") return "Expire unfunded bond";
  if (action === "refund_unresolved") return "Settle unresolved bond to beneficiary";
  if (action === "refund_stale") return "Settle stale bond to beneficiary";
  return "Resolve with GenLayer consensus";
}

function availableActions(state: PromiseBondState, record: PromiseBondLocalRecord) {
  const now = BigInt(Math.floor(Date.now() / 1_000));
  const fundingDeadline = BigInt(record.fundingDeadlineSeconds);
  const deadline = BigInt(record.resolutionDeadlineSeconds);
  const actions: PromiseBondActionName[] = [];
  if (state.settlement === "UNFUNDED" && now >= fundingDeadline) actions.push("expire_unfunded");
  if (state.settlement === "LOCKED" && state.outcome === "NONE" && now >= deadline) actions.push("resolve");
  if (state.settlement === "LOCKED" && state.outcome === "NONE" && now >= deadline + 30n * 24n * 60n * 60n) {
    actions.push("refund_stale");
  }
  if (
    state.settlement === "LOCKED"
    && state.outcome === "UNRESOLVED"
    && now >= state.resolved_at + 7n * 24n * 60n * 60n
  ) {
    actions.push("refund_unresolved");
  }
  return actions;
}

function scrollToId(id: string) {
  document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
}

export function PublicHomePage({ currentPage = "open-bond" }: {
  currentPage?: "open-bond" | "my-bonds";
}) {
  const account = useAccount();
  const [draft, setDraft] = useState<BondDraft>(createInitialDraft);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [beneficiaryConfirmed, setBeneficiaryConfirmed] = useState(false);
  const [evidencePreflight, setEvidencePreflight] = useState<ReviewedEvidencePreflight>();
  const [evidencePreflightPending, setEvidencePreflightPending] = useState(false);
  const [submissionProgress, setSubmissionProgress] = useState<PromiseBondProgress>();
  const [submissionError, setSubmissionError] = useState("");
  const [walletRpcRepairRequired, setWalletRpcRepairRequired] = useState(false);
  const [walletRpcRepairPending, setWalletRpcRepairPending] = useState(false);
  const [records, setRecords] = useState<PromiseBondLocalRecord[]>([]);
  const [ledgerReady, setLedgerReady] = useState(false);
  const [currentOperationId, setCurrentOperationId] = useState<string>();
  const [managedRecordId, setManagedRecordId] = useState<string>();
  const [managedBond, setManagedBond] = useState<Awaited<ReturnType<typeof readFinalPromiseBond>>>();
  const [managementError, setManagementError] = useState("");
  const [managementPending, setManagementPending] = useState(false);
  const recordsRef = useRef<PromiseBondLocalRecord[]>([]);
  const evidenceFingerprintRef = useRef("");
  const evidencePreflightLock = useRef(false);
  const evidencePreflightRef = useRef<ReviewedEvidencePreflight | undefined>(undefined);
  const submissionLock = useRef(false);
  const managementLock = useRef(false);
  const reconciliationLocks = useRef(new Set<string>());
  const evidenceUrls = parseEvidenceUrls(draft.evidenceUrls);
  const currentEvidenceFingerprint = evidenceFingerprint(evidenceUrls);
  evidenceFingerprintRef.current = currentEvidenceFingerprint;
  evidencePreflightRef.current = evidencePreflight;
  const submissionPending = submissionProgress !== undefined && submissionProgress !== "complete";
  const wrongNetwork = account.isConnected && account.chainId !== promiseBondChain.id;
  const resolutionMinimum = getResolutionMinimum(draft.fundingDeadline);
  const currentRecord = records.find((record) => record.id === currentOperationId);
  const managedRecord = records.find((record) => record.id === managedRecordId);
  const reviewDialogRef = useModalDialog(reviewOpen, () => setReviewOpen(false));
  const manageDialogRef = useModalDialog(Boolean(managedRecord), () => setManagedRecordId(undefined));
  const reviewDraft = currentRecord?.draft ?? draft;
  const reviewEvidenceUrls = currentRecord?.evidenceUrls ?? evidenceUrls;
  const reviewCreator = currentRecord?.creator ?? account.address;
  const evidencePreflightIsFresh = Boolean(
    evidencePreflight
    && Date.now() - evidencePreflight.verifiedAt < EVIDENCE_PREFLIGHT_MAX_AGE_MS
  );
  const reviewEvidencePreflight = evidencePreflightIsFresh
    && evidencePreflight?.fingerprint === evidenceFingerprint(reviewEvidenceUrls)
    ? evidencePreflight
    : undefined;
  const deployedContract: (PromiseBondDeployedContract & { amountWei: bigint }) | undefined = currentRecord?.contractAddress
    && currentRecord.deploymentTxId
    && currentRecord.stage === "deployed_unfunded"
    ? {
        amountWei: BigInt(currentRecord.amountWei),
        contractAddress: currentRecord.contractAddress,
        deploymentTxId: currentRecord.deploymentTxId
      }
    : undefined;
  const deployment: PromiseBondDeployment | undefined = currentRecord?.contractAddress
    && currentRecord.deploymentTxId
    && currentRecord.fundingTxId
    && currentRecord.stage === "funded"
    ? {
        contractAddress: currentRecord.contractAddress,
        deploymentTxId: currentRecord.deploymentTxId,
        fundingTxId: currentRecord.fundingTxId
      }
    : undefined;
  const activeBonds = records
    .filter((record) => (
      (record.contractAddress || isRecoverableRecord(record))
      && (!account.address || record.creator.toLowerCase() === account.address.toLowerCase())
    ))
    .map((record) => ({
      fundingDeadline: formatUtcDeadline(record.draft.fundingDeadline),
      id: record.contractAddress
        ? `${record.contractAddress.slice(0, 8)}…${record.contractAddress.slice(-6)}`
        : record.deploymentTxId
          ? shortTransaction(record.deploymentTxId)
          : "Pending bond",
      promise: record.draft.promise,
      record,
      resolutionDeadline: formatUtcDeadline(record.draft.resolutionDeadline),
      stake: `${record.draft.stake} GEN`,
      status: recordStageLabel(record)
    }));
  const managedActions = managedBond && managedRecord && !managedRecord.pendingAction
    ? availableActions(managedBond.state, managedRecord)
    : [];
  const managedCanFund = Boolean(
    managedBond
    && managedRecord
    && managedBond.state.settlement === "UNFUNDED"
    && BigInt(Math.floor(Date.now() / 1_000)) < BigInt(managedRecord.fundingDeadlineSeconds)
  );
  const connectedCurrentCreator = Boolean(
    account.address
    && currentRecord
    && account.address.toLowerCase() === currentRecord.creator.toLowerCase()
  );
  const recoveryFingerprint = records.map((record) => (
    `${record.id}:${record.stage}:${record.deploymentTxId ?? ""}:${record.fundingTxId ?? ""}:${record.pendingAction?.transactionId ?? ""}`
  )).join("|");

  useEffect(() => {
    const loaded = loadPromiseBondLocalRecords();
    recordsRef.current = loaded;
    setRecords(loaded);
    setLedgerReady(true);
  }, []);

  useEffect(() => {
    if (!evidencePreflight) return;
    const remaining = evidencePreflight.verifiedAt
      + EVIDENCE_PREFLIGHT_MAX_AGE_MS
      - Date.now();
    if (remaining <= 0) {
      setEvidencePreflight(undefined);
      return;
    }
    const timer = window.setTimeout(() => setEvidencePreflight(undefined), remaining);
    return () => window.clearTimeout(timer);
  }, [evidencePreflight]);

  useEffect(() => {
    if (!ledgerReady) return;
    const addresses = Array.from(new Set(
      recordsRef.current.flatMap((record) => record.contractAddress ? [record.contractAddress] : [])
    )).slice(0, 10);
    for (const address of addresses) syncContractToIndex(address);
  }, [ledgerReady]);

  useEffect(() => {
    if (!ledgerReady || !account.address) return;
    let cancelled = false;
    void listPromiseBondsForCreator(getAddress(account.address))
      .then((indexed) => {
        if (cancelled) return;
        const known = new Set(recordsRef.current.flatMap((record) => (
          record.contractAddress ? [record.contractAddress.toLowerCase()] : []
        )));
        const recovered = indexed
          .filter((bond) => !known.has(bond.contractAddress.toLowerCase()))
          .map(indexedBondRecord);
        if (recovered.length > 0) commitRecords((current) => [...recovered, ...current]);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [account.address, ledgerReady]);

  useEffect(() => {
    if (!ledgerReady || !account.address) return;
    const creator = account.address.toLowerCase();
    const currentBelongsToCreator = recordsRef.current.some(
      (record) => record.id === currentOperationId && record.creator.toLowerCase() === creator
    );
    if (currentBelongsToCreator) return;
    const recoverable = recordsRef.current.find(
      (record) => record.creator.toLowerCase() === creator && isRecoverableRecord(record)
    );
    setCurrentOperationId(recoverable?.id);
  }, [account.address, currentOperationId, ledgerReady]);

  useEffect(() => {
    if (!ledgerReady || !account.address) return;
    const recoverable = recordsRef.current.find(
      (record) => record.creator.toLowerCase() === account.address!.toLowerCase()
        && isRecoverableRecord(record)
    );
    if (!recoverable || reconciliationLocks.current.has(recoverable.id)) return;
    reconciliationLocks.current.add(recoverable.id);
    void reconcileStoredRecord(recoverable)
      .catch((error) => {
        if (recordsRef.current.some((record) => record.id === recoverable.id)) {
          const terminal = transitionFinalizedFailure(
            recordsRef.current.find((record) => record.id === recoverable.id) ?? recoverable,
            error
          );
          setSubmissionError(terminal
            ? `${error instanceof Error ? error.message : "Transaction failed"}. The proven failed hash was cleared; a fresh submission is now allowed.`
            : error instanceof Error ? error.message : "Could not reconcile the saved Bradbury transaction");
        }
      })
      .finally(() => reconciliationLocks.current.delete(recoverable.id));
  }, [account.address, ledgerReady, recoveryFingerprint]);

  function commitRecords(update: (current: PromiseBondLocalRecord[]) => PromiseBondLocalRecord[]) {
    const saved = savePromiseBondLocalRecords(update(recordsRef.current));
    recordsRef.current = saved;
    setRecords(saved);
    return saved;
  }

  function updateStoredRecord(id: string, patch: Partial<PromiseBondLocalRecord>) {
    const now = new Date().toISOString();
    return commitRecords((current) => current.map((record) => (
      record.id === id ? { ...record, ...patch, updatedAt: now } : record
    )));
  }

  function transitionFinalizedFailure(record: PromiseBondLocalRecord, error: unknown) {
    if (!isPromiseBondFinalizedFailure(error)) return false;
    const failedAt = new Date().toISOString();
    if (
      record.stage === "deployment_submitted"
      && record.deploymentTxId?.toLowerCase() === error.transactionId.toLowerCase()
    ) {
      updateStoredRecord(record.id, {
        deploymentTxId: undefined,
        lastFailedTransaction: { failedAt, kind: "deployment", transactionId: error.transactionId },
        stage: "deployment_failed"
      });
      if (currentOperationId === record.id) {
        setDraft({ ...record.draft });
        setBeneficiaryConfirmed(false);
        setCurrentOperationId(undefined);
        setSubmissionProgress(undefined);
      }
      return true;
    }
    if (
      record.stage === "funding_submitted"
      && record.fundingTxId?.toLowerCase() === error.transactionId.toLowerCase()
    ) {
      updateStoredRecord(record.id, {
        fundingTxId: undefined,
        lastFailedTransaction: { failedAt, kind: "funding", transactionId: error.transactionId },
        stage: "deployed_unfunded"
      });
      if (currentOperationId === record.id) setSubmissionProgress(undefined);
      return true;
    }
    if (record.pendingAction?.transactionId.toLowerCase() === error.transactionId.toLowerCase()) {
      updateStoredRecord(record.id, {
        lastFailedTransaction: { failedAt, kind: "action", transactionId: error.transactionId },
        pendingAction: undefined
      });
      return true;
    }
    return false;
  }

  async function verifyStoredDeployment(record: PromiseBondLocalRecord) {
    if (!record.contractAddress || !record.deploymentTxId) {
      throw new Error("Saved PromiseBond is missing its finalized deployment identity");
    }
    const verified = await reconcilePromiseBondDeployment({
      account: record.creator,
      deploymentTxId: record.deploymentTxId,
      draft: contractDraft(record.draft)
    });
    if (verified.contractAddress.toLowerCase() !== record.contractAddress.toLowerCase()) {
      throw new Error("Saved PromiseBond contract does not match its reviewed deployment transaction");
    }
    return verified;
  }

  async function verifyStoredContract(record: PromiseBondLocalRecord) {
    if (record.deploymentTxId) return verifyStoredDeployment(record);
    if (!record.contractAddress) throw new Error("Saved PromiseBond is missing its contract address");
    const intended = contractDraft(record.draft);
    const snapshot = await readFinalPromiseBond(record.contractAddress);
    const terms = snapshot.terms;
    if (
      terms.creator.toLowerCase() !== record.creator.toLowerCase()
      || terms.beneficiary.toLowerCase() !== intended.beneficiary.toLowerCase()
      || terms.bond_amount_wei !== intended.amountWei
      || terms.funding_deadline !== intended.fundingDeadline
      || terms.deadline !== intended.deadline
      || terms.promise_text !== intended.promise
      || terms.success_criteria !== intended.successCriteria
      || terms.failure_criteria !== intended.failureCriteria
      || terms.evidence_urls !== JSON.stringify(intended.evidenceUrls)
    ) {
      throw new Error("Indexed PromiseBond terms do not match finalized Bradbury state");
    }
    return snapshot;
  }

  async function reconcileStoredRecord(saved: PromiseBondLocalRecord) {
    let record = saved;
    const terms = contractDraft(record.draft);
    if (record.stage === "deployment_submitted") {
      if (!record.deploymentTxId) throw new Error("Saved deployment is missing its transaction ID");
      if (record.id === currentOperationId) setSubmissionProgress("deployment_finalizing");
      const deployed = await reconcilePromiseBondDeployment({
        account: record.creator,
        deploymentTxId: record.deploymentTxId,
        draft: terms
      });
      updateStoredRecord(record.id, {
        contractAddress: deployed.contractAddress,
        deploymentTxId: deployed.deploymentTxId,
        stage: "deployed_unfunded"
      });
      record = recordsRef.current.find((candidate) => candidate.id === record.id)!;
      if (record.id === currentOperationId) setSubmissionProgress("deployment_finalized");
    }

    if (record.contractAddress && record.deploymentTxId) {
      await verifyStoredDeployment(record);
    }

    if (record.pendingAction) {
      if (!record.contractAddress) throw new Error("Saved action is missing its PromiseBond contract address");
      const action = record.pendingAction;
      await reconcilePromiseBondAction({
        account: record.creator,
        address: record.contractAddress,
        functionName: action.functionName,
        transactionId: action.transactionId
      });
      updateStoredRecord(record.id, { lastAction: action, pendingAction: undefined });
      record = recordsRef.current.find((candidate) => candidate.id === record.id)!;
    }

    if (record.stage === "funding_submitted") {
      if (!record.contractAddress || !record.fundingTxId) {
        throw new Error("Saved funding is missing its contract or transaction ID");
      }
      if (record.id === currentOperationId) setSubmissionProgress("funding_finalizing");
      await reconcilePromiseBondFunding({
        account: record.creator,
        amountWei: BigInt(record.amountWei),
        contractAddress: record.contractAddress,
        fundingTxId: record.fundingTxId
      });
      updateStoredRecord(record.id, { stage: "funded" });
      record = recordsRef.current.find((candidate) => candidate.id === record.id)!;
      if (record.id === currentOperationId) setSubmissionProgress("complete");
    }

    // A recovered deployment stops at the intentionally unfunded checkpoint.
    // Clear the finality spinner so the creator can explicitly submit the
    // separate native-GEN funding transaction without redeploying.
    if (record.stage === "deployed_unfunded" && record.id === currentOperationId) {
      setSubmissionProgress(undefined);
    }

    if (!record.contractAddress) return;
    const snapshot = await readFinalPromiseBond(record.contractAddress);
    if (snapshot.state.settlement !== "UNFUNDED" && record.stage !== "funded") {
      updateStoredRecord(record.id, { stage: "funded" });
    }
    if (managedRecordId === record.id) setManagedBond(snapshot);
    syncContractToIndex(record.contractAddress);
  }

  async function reconcileSavedOperation(record: PromiseBondLocalRecord) {
    if (reconciliationLocks.current.has(record.id)) return;
    reconciliationLocks.current.add(record.id);
    setSubmissionError("");
    setManagementError("");
    if (record.pendingAction) setManagementPending(true);
    try {
      await reconcileStoredRecord(record);
    } catch (error) {
      const latest = recordsRef.current.find((candidate) => candidate.id === record.id) ?? record;
      const terminal = transitionFinalizedFailure(latest, error);
      const message = terminal
        ? `${error instanceof Error ? error.message : "Transaction failed"}. The proven failed hash was cleared; a fresh submission is now allowed.`
        : error instanceof Error ? error.message : "Could not reconcile the saved Bradbury transaction";
      if (record.pendingAction) setManagementError(message);
      else setSubmissionError(message);
    } finally {
      reconciliationLocks.current.delete(record.id);
      setManagementPending(false);
    }
  }

  function updateDraft(key: keyof BondDraft, value: string) {
    if (key === "beneficiary") setBeneficiaryConfirmed(false);
    if (key === "evidenceUrls") setEvidencePreflight(undefined);
    setDraft((current) => ({ ...current, [key]: value }));
  }

  async function reviewTerms(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmissionError("");
    if (currentRecord) {
      setReviewOpen(true);
      return;
    }
    if (evidencePreflightLock.current) return;
    try {
      const urls = parseEvidenceUrls(draft.evidenceUrls);
      assertNewEvidencePolicy(urls);
      contractDraft(draft);
      const fingerprint = evidenceFingerprint(urls);
      evidencePreflightLock.current = true;
      setEvidencePreflight(undefined);
      setEvidencePreflightPending(true);
      const result = await preflightPromiseBondEvidence(urls);
      if (evidenceFingerprintRef.current !== fingerprint) {
        throw new Error("Evidence URLs changed during preflight; verify the current three URLs again");
      }
      setEvidencePreflight({ fingerprint, result, verifiedAt: Date.now() });
      setBeneficiaryConfirmed(false);
      setReviewOpen(true);
    } catch (error) {
      setSubmissionError(error instanceof Error ? error.message : "Review the PromiseBond terms");
    } finally {
      evidencePreflightLock.current = false;
      setEvidencePreflightPending(false);
    }
  }

  function contractDraft(source: BondDraft): ContractDraft {
    const urls = parseEvidenceUrls(source.evidenceUrls);
    return {
      amountWei: parseTestGenAmount(source.stake),
      beneficiary: getAddress(source.beneficiary),
      deadline: parseUtcDateTime(source.resolutionDeadline, "Resolution deadline"),
      evidenceUrls: urls,
      failureCriteria: source.failureCriteria,
      fundingDeadline: parseUtcDateTime(source.fundingDeadline, "Funding deadline"),
      promise: source.promise,
      successCriteria: source.successCriteria
    };
  }

  async function connectedProvider() {
    if (!account.address || !account.connector) throw new Error("Connect the creator wallet first");
    if (wrongNetwork) throw new Error("Switch the wallet to GenLayer Bradbury before continuing");
    const provider = await account.connector.getProvider({ chainId: promiseBondChain.id });
    if (!provider || typeof provider !== "object" || !("request" in provider) || typeof provider.request !== "function") {
      throw new Error("Connected wallet did not provide an EIP-1193 signer");
    }
    return provider as PromiseBondWalletProvider;
  }

  function captureWalletRpcCompatibilityError(error: unknown) {
    const incompatible = isPromiseBondWalletRpcCompatibilityError(error);
    if (incompatible) setWalletRpcRepairRequired(true);
    return incompatible;
  }

  async function repairWalletRpc() {
    if (walletRpcRepairPending) return;
    setWalletRpcRepairPending(true);
    setSubmissionError("");
    setManagementError("");
    try {
      const provider = await connectedProvider();
      await repairBradburyWalletRpc({
        account: account.address ? getAddress(account.address) : undefined,
        provider
      });
      setWalletRpcRepairRequired(false);
      const message = "Wallet network update requested. Retry the PromiseBond transaction; if the same error returns, select the official GenLayer chain RPC in your wallet's chain 4221 settings.";
      setSubmissionError(message);
      setManagementError(message);
    } catch (error) {
      setWalletRpcRepairRequired(true);
      const message = error instanceof Error ? error.message : "Wallet RPC repair was not completed";
      setSubmissionError(message);
      setManagementError(message);
    } finally {
      setWalletRpcRepairPending(false);
    }
  }

  async function deployAndFund() {
    if (submissionLock.current) return;
    submissionLock.current = true;
    setSubmissionError("");
    let operationId: string | undefined;
    try {
      if (!account.address) throw new Error("Connect the creator wallet first");
      if (!ledgerReady) throw new Error("Local transaction recovery is still loading");
      if (!beneficiaryConfirmed) throw new Error("Confirm the beneficiary address before signing");
      assertPromiseBondPersistenceAvailable();
      const urls = parseEvidenceUrls(draft.evidenceUrls);
      assertNewEvidencePolicy(urls);
      const terms = contractDraft(draft);
      const fingerprint = evidenceFingerprint(terms.evidenceUrls);
      const verifiedEvidence = evidencePreflightRef.current;
      if (!verifiedEvidence) {
        throw new Error("Run evidence preflight again before requesting a wallet signature");
      }
      if (verifiedEvidence.fingerprint !== fingerprint) {
        throw new Error("Evidence URLs changed after preflight; verify the current three URLs again");
      }
      if (Date.now() - verifiedEvidence.verifiedAt >= EVIDENCE_PREFLIGHT_MAX_AGE_MS) {
        setEvidencePreflight(undefined);
        throw new Error("Evidence preflight expired; verify the three URLs again before signing");
      }
      const provider = await connectedProvider();
      const creator = getAddress(account.address);
      operationId = createPromiseBondOperationId();
      const createdAt = new Date().toISOString();
      const prepared: PromiseBondLocalRecord = {
        amountWei: terms.amountWei.toString(),
        chainId: 4221,
        createdAt,
        creator,
        draft: { ...draft },
        evidenceUrls: [...terms.evidenceUrls],
        fundingDeadlineSeconds: terms.fundingDeadline.toString(),
        id: operationId,
        network: "bradbury",
        resolutionDeadlineSeconds: terms.deadline.toString(),
        stage: "prepared",
        updatedAt: createdAt
      };
      commitRecords((current) => [prepared, ...current]);
      setCurrentOperationId(operationId);
      const completed = await deployAndFundPromiseBond({
        account: creator,
        draft: terms,
        onDeploymentSubmitted: (deploymentTxId) => {
          updateStoredRecord(operationId!, { deploymentTxId, stage: "deployment_submitted" });
        },
        onDeployed: (created) => {
          updateStoredRecord(operationId!, {
            contractAddress: created.contractAddress,
            deploymentTxId: created.deploymentTxId,
            stage: "deployed_unfunded"
          });
          syncContractToIndex(created.contractAddress);
        },
        onFundingSubmitted: (fundingTxId) => {
          updateStoredRecord(operationId!, { fundingTxId, stage: "funding_submitted" });
        },
        onProgress: setSubmissionProgress,
        provider
      });
      updateStoredRecord(operationId, {
        contractAddress: completed.contractAddress,
        deploymentTxId: completed.deploymentTxId,
        fundingTxId: completed.fundingTxId,
        stage: "funded"
      });
      syncContractToIndex(completed.contractAddress);
    } catch (error) {
      setSubmissionProgress(undefined);
      captureWalletRpcCompatibilityError(error);
      const latest = operationId ? recordsRef.current.find((candidate) => candidate.id === operationId) : undefined;
      const terminal = latest ? transitionFinalizedFailure(latest, error) : false;
      setSubmissionError(terminal
        ? `${error instanceof Error ? error.message : "Transaction failed"}. Review the restored terms before a fresh submission.`
        : error instanceof Error ? error.message : "PromiseBond transaction failed");
      if (operationId) {
        const record = recordsRef.current.find((candidate) => candidate.id === operationId);
        if (record?.stage === "prepared" && !record.deploymentTxId) {
          commitRecords((current) => current.filter((candidate) => candidate.id !== operationId));
          setCurrentOperationId(undefined);
        }
      }
    } finally {
      submissionLock.current = false;
    }
  }

  async function retryFunding(record = currentRecord) {
    if (!record?.contractAddress || !account.address) return;
    if (record.fundingTxId || record.stage === "funding_submitted") {
      setSubmissionError("A funding transaction is already recorded. Reconcile it before sending another.");
      return;
    }
    if (submissionLock.current) return;
    submissionLock.current = true;
    setSubmissionError("");
    try {
      await verifyStoredContract(record);
      const provider = await connectedProvider();
      const fundingTxId = await fundPromiseBond({
        account: getAddress(account.address),
        amountWei: BigInt(record.amountWei),
        contractAddress: record.contractAddress,
        onFundingSubmitted: (transactionId) => {
          updateStoredRecord(record.id, { fundingTxId: transactionId, stage: "funding_submitted" });
        },
        onProgress: setSubmissionProgress,
        provider
      });
      setSubmissionProgress("complete");
      updateStoredRecord(record.id, { fundingTxId, stage: "funded" });
      syncContractToIndex(record.contractAddress);
    } catch (error) {
      setSubmissionProgress(undefined);
      captureWalletRpcCompatibilityError(error);
      const latest = recordsRef.current.find((candidate) => candidate.id === record.id) ?? record;
      const terminal = transitionFinalizedFailure(latest, error);
      setSubmissionError(terminal
        ? `${error instanceof Error ? error.message : "Funding failed"}. The proven failed funding hash was cleared; retry is available.`
        : error instanceof Error ? error.message : "PromiseBond funding failed");
    } finally {
      submissionLock.current = false;
    }
  }

  function resetBuilder() {
    setCurrentOperationId(undefined);
    setDraft(createInitialDraft());
    setBeneficiaryConfirmed(false);
    setEvidencePreflight(undefined);
    setEvidencePreflightPending(false);
    setSubmissionError("");
    setSubmissionProgress(undefined);
    setWalletRpcRepairRequired(false);
    setReviewOpen(false);
    scrollToId("create-bond");
  }

  async function openBond(record: PromiseBondLocalRecord) {
    if (!record.contractAddress) return;
    setManagedRecordId(record.id);
    setManagedBond(undefined);
    setManagementError("");
    try {
      await verifyStoredContract(record);
      setManagedBond(await readFinalPromiseBond(record.contractAddress));
    } catch (error) {
      setManagementError(error instanceof Error ? error.message : "Could not read finalized PromiseBond state");
    }
  }

  async function runBondAction(action: PromiseBondActionName) {
    if (!managedRecord?.contractAddress || !account.address || managementLock.current) return;
    if (managedRecord.pendingAction) {
      setManagementError("Reconcile the saved lifecycle transaction before submitting another action.");
      return;
    }
    managementLock.current = true;
    setManagementPending(true);
    setManagementError("");
    try {
      const provider = await connectedProvider();
      const completed = await submitPromiseBondAction({
        account: getAddress(account.address),
        address: managedRecord.contractAddress,
        functionName: action,
        onSubmitted: (transactionId) => {
          updateStoredRecord(managedRecord.id, {
            pendingAction: { functionName: action, transactionId }
          });
        },
        provider
      });
      updateStoredRecord(managedRecord.id, {
        lastAction: { functionName: action, transactionId: completed.transactionId },
        pendingAction: undefined
      });
      setManagedBond(await readFinalPromiseBond(managedRecord.contractAddress));
      syncContractToIndex(managedRecord.contractAddress);
    } catch (error) {
      captureWalletRpcCompatibilityError(error);
      const latest = recordsRef.current.find((candidate) => candidate.id === managedRecord.id) ?? managedRecord;
      const terminal = transitionFinalizedFailure(latest, error);
      setManagementError(terminal
        ? `${error instanceof Error ? error.message : "Lifecycle action failed"}. The proven failed action hash was cleared; retry is available.`
        : error instanceof Error ? error.message : "PromiseBond action failed");
    } finally {
      managementLock.current = false;
      setManagementPending(false);
    }
  }

  return (
    <main className="promisebond">
      <PromiseBondHeader currentPage={currentPage} />

      <div className="pb-frame">
        <section className="pb-hero pb-home-hero" aria-labelledby="promisebond-title">
          <div className="pb-hero-copy">
            <h1 id="promisebond-title" tabIndex={-1}>Put GEN behind the promises you make.</h1>
            <p>
              Define a measurable public commitment, lock GEN behind it, and let GenLayer resolve
              the outcome from approved public evidence.
            </p>
            <div className="pb-hero-actions">
              <a className="pb-button primary" href="/#create-bond">
                Open a promise <ArrowRight size={17} />
              </a>
              <a className="pb-button quiet" href="/how-it-works">
                How it works <ArrowRight size={17} />
              </a>
            </div>
          </div>
        </section>

        <section className="pb-builder" id="create-bond" aria-labelledby="open-bond-title">
          <header className="pb-section-heading">
            <div>
              <span>DEFINE YOUR BOND</span>
              <h2 id="open-bond-title" tabIndex={-1}>Open a PromiseBond</h2>
            </div>
            <p>Write deterministic terms GenLayer validators can decide from the approved public record.</p>
          </header>

          <div className="pb-builder-grid">
            <form aria-busy={evidencePreflightPending} className="pb-window" onSubmit={reviewTerms}>
              <div className="pb-window-bar">
                <span><i /><i /><i /></span>
                <b>PROMISE.TERMS</b>
                <em>GENLAYER BRADBURY / 4221</em>
              </div>
              <div className="pb-window-body">
                <label className="pb-field full">
                  <span>THE PROMISE</span>
                  <textarea
                    maxLength={3000}
                    onChange={(event) => updateDraft("promise", event.target.value)}
                    placeholder="Example: Publish the audited Android release before the resolution deadline."
                    required
                    value={draft.promise}
                  />
                  <small>State the public commitment without embedding the decision rule.</small>
                </label>

                <div className="pb-field-grid pb-criteria-grid">
                  <label className="pb-field">
                    <span>SUCCESS CRITERIA <b>FULFILLED</b></span>
                    <textarea
                      maxLength={3000}
                      onChange={(event) => updateDraft("successCriteria", event.target.value)}
                      placeholder="List the public facts that prove every part of the promise was fulfilled."
                      required
                      value={draft.successCriteria}
                    />
                    <small>List every fact the approved sources must materially prove.</small>
                  </label>
                  <label className="pb-field">
                    <span>FAILURE CRITERIA <b>FAILED</b></span>
                    <textarea
                      maxLength={3000}
                      onChange={(event) => updateDraft("failureCriteria", event.target.value)}
                      placeholder="List the public facts that prove the promise failed by the deadline."
                      required
                      value={draft.failureCriteria}
                    />
                    <small>Say what proves failure; ambiguity may produce an unresolved outcome.</small>
                  </label>
                </div>

                <div className="pb-field-grid">
                  <label className="pb-field">
                    <span>BOND AMOUNT <b>GEN</b></span>
                    <div className="pb-input-prefix">
                      <strong>GEN</strong>
                      <input
                        inputMode="decimal"
                        onChange={(event) => updateDraft("stake", event.target.value)}
                        pattern="[0-9]+([.][0-9]{1,18})?"
                        placeholder="0.00"
                        required
                        title="Enter a positive GEN amount with no more than 18 decimal places"
                        value={draft.stake}
                      />
                    </div>
                    <small>The creator must later fund this exact native amount.</small>
                  </label>
                  <label className="pb-field">
                    <span>BENEFICIARY WALLET <b>EOA</b></span>
                    <input
                      autoCapitalize="off"
                      autoCorrect="off"
                      className="pb-address-input"
                      onChange={(event) => updateDraft("beneficiary", event.target.value)}
                      pattern="0x[a-fA-F0-9]{40}"
                      placeholder="0x…"
                      required
                      spellCheck={false}
                      title="Enter a 20-byte 0x wallet address"
                      value={draft.beneficiary}
                    />
                    <small>A failed bond pays this nonzero externally owned account, not a contract.</small>
                  </label>
                </div>

                <div className="pb-field-grid">
                  <label className="pb-field">
                    <span>FUNDING DEADLINE <b>UTC</b></span>
                    <input
                      onChange={(event) => updateDraft("fundingDeadline", event.target.value)}
                      required
                      step={60}
                      type="datetime-local"
                      value={draft.fundingDeadline}
                    />
                    <small>Enter UTC directly; the interface does not convert local time.</small>
                  </label>
                  <label className="pb-field">
                    <span>RESOLUTION DEADLINE <b>UTC</b></span>
                    <input
                      min={resolutionMinimum}
                      onChange={(event) => updateDraft("resolutionDeadline", event.target.value)}
                      required
                      step={60}
                      type="datetime-local"
                      value={draft.resolutionDeadline}
                    />
                    <small>Must follow funding. Consensus resolution can start after this UTC time.</small>
                  </label>
                </div>

                <label className="pb-field full">
                  <span>APPROVED EVIDENCE URLS <b>EXACTLY 3 INDEPENDENT HTTPS</b></span>
                  <div className="pb-input-icon pb-input-multiline">
                    <Link2 size={16} />
                    <textarea
                      maxLength={2504}
                      onChange={(event) => updateDraft("evidenceUrls", event.target.value)}
                      placeholder={"https://registry.example.org/package/1.0.0\nhttps://cdn.example.net/package.json\nhttps://raw.example.com/project/v1/package.json"}
                      required
                      spellCheck={false}
                      value={draft.evidenceUrls}
                    />
                  </div>
                  <small>Exactly three small, direct HTTPS sources on different authorities. Avoid repository pages and other large or dynamic HTML. All three must pass the server preflight before review.</small>
                </label>
              </div>
              <footer className="pb-window-footer">
                <span><ShieldCheck size={16} /> Draft stays local; every submitted transaction ID is saved for recovery on this device.</span>
                <button className="pb-button primary compact" disabled={evidencePreflightPending} type="submit">
                  {evidencePreflightPending ? "Verifying 3 sources..." : <>Review terms <ArrowRight size={16} /></>}
                </button>
              </footer>
              {evidencePreflightPending ? (
                <div aria-live="polite" className="pb-preflight-progress" role="status">
                  <i /> Fetching and hashing the exact three evidence sources before review. No wallet request will open.
                </div>
              ) : null}
              {submissionError && !reviewOpen ? <p className="pb-form-error" role="alert">{submissionError}</p> : null}
            </form>

            <aside className="pb-live-card" aria-label="Bond preview">
              <div className="pb-live-card-head">
                <span>LIVE TERMS PREVIEW</span>
                <Sparkles size={17} />
              </div>
              <div className="pb-live-promise">“{draft.promise || "Your promise appears here."}”</div>
              <dl>
                <div><dt>BOND</dt><dd>{draft.stake || "0"} GEN <small>native on Bradbury</small></dd></div>
                <div><dt>FUND BY</dt><dd>{formatUtcDeadline(draft.fundingDeadline)}</dd></div>
                <div><dt>RESOLVE AFTER</dt><dd>{formatUtcDeadline(draft.resolutionDeadline)}</dd></div>
                <div><dt>SUCCESS</dt><dd>{draft.successCriteria || "Not set"}</dd></div>
                <div><dt>FAILURE</dt><dd>{draft.failureCriteria || "Not set"}</dd></div>
                <div><dt>BENEFICIARY EOA</dt><dd>{draft.beneficiary || "Not set"}</dd></div>
                <div><dt>EVIDENCE</dt><dd>{evidenceUrls.length} approved public URL{evidenceUrls.length === 1 ? "" : "s"}</dd></div>
                <div><dt>RESOLVER</dt><dd><span className="pb-verdict-tag">GenLayer consensus</span></dd></div>
              </dl>
              <div className="pb-live-card-foot">
                <Network size={16} /><span>Terms, native value, resolution, and payout all remain on GenLayer Bradbury.</span>
              </div>
            </aside>
          </div>
        </section>

        <section className="pb-bond-feed" id="bond-feed" aria-labelledby="active-bonds-title">
          <header className="pb-section-heading">
            <div>
              <span>YOUR BONDS</span>
              <h2 id="active-bonds-title" tabIndex={-1}>Your PromiseBonds</h2>
            </div>
          </header>
          <div className="pb-bond-list">
            {activeBonds.length === 0 ? (
              <div className="pb-bond-empty">
                <strong>No PromiseBonds on this device yet.</strong>
                <span>Submitted transactions and saved bonds will appear here.</span>
              </div>
            ) : activeBonds.map((bond) => (
              <article className="pb-bond-row" key={bond.record.id}>
                <div className="pb-bond-id"><span>{bond.id}</span><i /></div>
                <div className="pb-bond-promise">
                  <strong>{bond.promise}</strong>
                  <small>
                    <Clock3 size={14} />
                    <span>Fund by {bond.fundingDeadline}<br />Resolve after {bond.resolutionDeadline}</span>
                  </small>
                </div>
                <div className="pb-bond-stake"><span>BRADBURY BOND</span><strong>{bond.stake}</strong></div>
                <div className={`pb-bond-state ${bond.status.replace(" ", "-")}`}><i />{bond.status}</div>
                <button
                  aria-label={`Open ${bond.id}`}
                  onClick={() => {
                    if (
                      bond.record.stage === "deployment_submitted"
                      || bond.record.stage === "funding_submitted"
                    ) {
                      setCurrentOperationId(bond.record.id);
                      setReviewOpen(true);
                      return;
                    }
                    void openBond(bond.record);
                  }}
                  type="button"
                >
                  <ArrowRight size={18} />
                </button>
              </article>
            ))}
          </div>
        </section>

        <footer className="pb-footer">
          <span>PromiseBond</span>
          <span><i /> GENLAYER BRADBURY · 4221</span>
        </footer>
      </div>

      {reviewOpen ? (
        <div className="pb-review-scrim" role="presentation">
          <section
            aria-labelledby="review-title"
            aria-modal="true"
            className="pb-review-modal"
            ref={reviewDialogRef}
            role="dialog"
            tabIndex={-1}
          >
            <header>
              <div><span>PRE-SIGN REVIEW</span><h2 id="review-title">Your terms are ready to inspect.</h2></div>
              <button aria-label="Close review" onClick={() => setReviewOpen(false)} type="button"><X size={19} /></button>
            </header>
            <div className="pb-review-content">
              <div className="pb-review-verdict">
                <ShieldCheck size={22} />
                <span>{reviewNotice(currentRecord)}</span>
              </div>
              <dl>
                <div><dt>PROMISE</dt><dd>{reviewDraft.promise}</dd></div>
                <div><dt>SUCCESS CRITERIA</dt><dd>{reviewDraft.successCriteria}</dd></div>
                <div><dt>FAILURE CRITERIA</dt><dd>{reviewDraft.failureCriteria}</dd></div>
                <div><dt>NATIVE BOND</dt><dd>{reviewDraft.stake} GEN</dd></div>
                <div><dt>CREATOR EOA</dt><dd>{reviewCreator ?? "Connect wallet"}</dd></div>
                <div><dt>FUND BY</dt><dd>{formatUtcDeadline(reviewDraft.fundingDeadline)}</dd></div>
                <div><dt>RESOLVE AFTER</dt><dd>{formatUtcDeadline(reviewDraft.resolutionDeadline)}</dd></div>
                <div><dt>BENEFICIARY EOA</dt><dd>{reviewDraft.beneficiary}</dd></div>
                <div>
                  <dt>EVIDENCE URLS</dt>
                  <dd>
                    <ol className="pb-review-evidence">
                      {reviewEvidenceUrls.map((url, index) => <li key={`${index}:${url}`}>{url}</li>)}
                    </ol>
                  </dd>
                </div>
                <div><dt>EVIDENCE AVAILABILITY</dt><dd>A strict majority of independent sources must be available. Missing quorum is FAILED, so the creator bears source-availability risk.</dd></div>
                <div><dt>UNRESOLVED SETTLEMENT</dt><dd>An unresolved outcome remains locked for 7 days, then the full bond can be queued to the beneficiary.</dd></div>
                <div><dt>STALE SETTLEMENT</dt><dd>If no resolution finalizes for 30 days after the deadline, the bond becomes FAILED and can be queued to the beneficiary.</dd></div>
                <div><dt>TRANSFER DELIVERY</dt><dd>Creator and beneficiary must be code-free EOAs. QUEUED means GenLayer emitted the native transfer message; recipient delivery is not separately proven by this app.</dd></div>
              </dl>
              {reviewEvidencePreflight ? (
                <section aria-labelledby="evidence-preflight-title" className="pb-evidence-preflight">
                  <header>
                    <ShieldCheck aria-hidden="true" size={20} />
                    <div>
                      <strong id="evidence-preflight-title">Evidence preflight passed</strong>
                      <span>All three exact URLs were fetched and hashed at {new Date(reviewEvidencePreflight.verifiedAt).toISOString()}.</span>
                    </div>
                  </header>
                  <ol>
                    {reviewEvidencePreflight.result.sources.map((source) => (
                      <li key={source.url}>
                        <a href={source.url} rel="noreferrer" target="_blank">{source.url}</a>
                        <dl className="pb-evidence-source-metadata">
                          <div><dt>HTTP</dt><dd>{source.status}</dd></div>
                          <div><dt>TYPE</dt><dd>{source.contentType}</dd></div>
                          <div><dt>SIZE</dt><dd>{formatByteCount(source.bytes)}</dd></div>
                          <div><dt>SHA-256</dt><dd>{source.sha256}</dd></div>
                        </dl>
                      </li>
                    ))}
                  </ol>
                </section>
              ) : !currentRecord ? (
                <div className="pb-submission-status warning" role="status">
                  <span><i /> Evidence preflight required</span>
                  <p>Close this review and choose Review terms again. Deployment stays blocked until the exact three current URLs pass a fresh preflight.</p>
                </div>
              ) : null}
              {!currentRecord ? (
                <label className="pb-beneficiary-confirmation">
                  <input
                    checked={beneficiaryConfirmed}
                    onChange={(event) => setBeneficiaryConfirmed(event.target.checked)}
                    type="checkbox"
                  />
                  <span>I verified that <strong>{reviewDraft.beneficiary}</strong> is the intended beneficiary EOA. A FAILED outcome queues the full bond to this exact address.</span>
                </label>
              ) : null}
              {submissionProgress ? (
                <div className={`pb-submission-status ${submissionProgress === "complete" ? "complete" : "pending"}`} role="status">
                  <span><i /> {PROGRESS_LABELS[submissionProgress]}</span>
                  {deployment ? (
                    <dl>
                      <div><dt>CONTRACT</dt><dd>{deployment.contractAddress}</dd></div>
                      <div><dt>DEPLOYMENT TX</dt><dd>{shortTransaction(deployment.deploymentTxId)}</dd></div>
                      <div><dt>FUNDING TX</dt><dd>{shortTransaction(deployment.fundingTxId)}</dd></div>
                    </dl>
                  ) : null}
                </div>
              ) : null}
              {deployedContract && !deployment ? (
                <div className="pb-submission-status warning" role="status">
                  <span><i /> Contract finalized but not funded</span>
                  <p>No principal is locked yet. Retry the separate funding transaction for {deployedContract.contractAddress}.</p>
                </div>
              ) : null}
              {currentRecord?.stage === "deployment_submitted" && currentRecord.deploymentTxId ? (
                <div className="pb-submission-status pending" role="status">
                  <span><i /> Deployment transaction saved</span>
                  <p>Finality can be reconciled without submitting another deployment: {shortTransaction(currentRecord.deploymentTxId)}.</p>
                </div>
              ) : null}
              {currentRecord?.stage === "funding_submitted" && currentRecord.fundingTxId ? (
                <div className="pb-submission-status pending" role="status">
                  <span><i /> Funding transaction saved</span>
                  <p>Do not fund again. Reconcile the recorded transaction first: {shortTransaction(currentRecord.fundingTxId)}.</p>
                </div>
              ) : null}
              {currentRecord?.lastFailedTransaction && currentRecord.lastFailedTransaction.kind !== "action" ? (
                <div className="pb-submission-status warning" role="status">
                  <span><i /> Previous {currentRecord.lastFailedTransaction.kind} finalized unsuccessfully</span>
                  <p>The failed hash remains in local history but is no longer treated as pending: {shortTransaction(currentRecord.lastFailedTransaction.transactionId)}.</p>
                </div>
              ) : null}
              {submissionError ? <p className="pb-submission-error" role="alert">{submissionError}</p> : null}
            </div>
            <footer>
              <button className="pb-button quiet" onClick={() => setReviewOpen(false)} type="button">Close</button>
              {walletRpcRepairRequired ? (
                <button
                  className="pb-button primary"
                  disabled={walletRpcRepairPending}
                  onClick={() => void repairWalletRpc()}
                  type="button"
                >
                  {walletRpcRepairPending ? "Updating wallet network…" : "Use official chain 4221 RPC"}
                </button>
              ) : currentRecord && (currentRecord.stage === "deployment_submitted" || currentRecord.stage === "funding_submitted") ? (
                <button
                  className="pb-button primary"
                  disabled={submissionPending}
                  onClick={() => void reconcileSavedOperation(currentRecord)}
                  type="button"
                >
                  {submissionPending ? PROGRESS_LABELS[submissionProgress!] : "Reconcile saved transaction"}
                </button>
              ) : deployment ? (
                <button className="pb-button primary" onClick={resetBuilder} type="button">Open another bond</button>
              ) : (
                <button
                  className={`pb-button ${account.isConnected && !wrongNetwork ? "primary" : "disabled"}`}
                  disabled={
                    !account.isConnected
                    || wrongNetwork
                    || submissionPending
                    || (!currentRecord && !beneficiaryConfirmed)
                    || (!currentRecord && !reviewEvidencePreflight)
                    || Boolean(deployedContract && !connectedCurrentCreator)
                    || Boolean(currentRecord && currentRecord.stage !== "deployed_unfunded")
                  }
                  onClick={() => void (deployedContract ? retryFunding() : deployAndFund())}
                  type="button"
                >
                  {!account.isConnected
                    ? "Connect wallet in header"
                    : wrongNetwork
                      ? "Switch to Bradbury"
                      : submissionPending
                        ? PROGRESS_LABELS[submissionProgress!]
                        : !currentRecord && !reviewEvidencePreflight
                          ? "Fresh evidence preflight required"
                        : currentRecord?.stage === "deployment_submitted"
                          ? "Deployment saved — reconciling"
                          : currentRecord?.stage === "funding_submitted"
                            ? "Funding saved — reconciling"
                            : deployedContract && !connectedCurrentCreator
                              ? "Connect the creator wallet to fund"
                            : deployedContract
                              ? "Retry native GEN funding"
                              : "Deploy and fund on Bradbury"}
                </button>
              )}
            </footer>
          </section>
        </div>
      ) : null}

      {managedRecord ? (
        <div className="pb-review-scrim" role="presentation">
          <section
            aria-labelledby="manage-bond-title"
            aria-modal="true"
            className="pb-review-modal pb-manage-modal"
            ref={manageDialogRef}
            role="dialog"
            tabIndex={-1}
          >
            <header>
              <div><span>FINALIZED BRADBURY STATE</span><h2 id="manage-bond-title">Manage PromiseBond</h2></div>
              <button aria-label="Close bond manager" onClick={() => setManagedRecordId(undefined)} type="button"><X size={19} /></button>
            </header>
            <div className="pb-review-content">
              <div className="pb-review-verdict">
                <ShieldCheck size={22} />
                <span>Every value below is read from the latest finalized GenLayer state. A queued payout means the contract emitted the native transfer message; it is not a separate proof that the recipient received it.</span>
              </div>
              <dl>
                <div><dt>CONTRACT</dt><dd>{managedRecord.contractAddress}</dd></div>
                <div><dt>PROMISE</dt><dd>{managedRecord.draft.promise}</dd></div>
                <div><dt>NATIVE BOND</dt><dd>{managedRecord.draft.stake} GEN</dd></div>
                <div><dt>BENEFICIARY</dt><dd>{managedRecord.draft.beneficiary}</dd></div>
                <div><dt>LOCAL STAGE</dt><dd>{recordStageLabel(managedRecord)}</dd></div>
                {managedBond ? (
                  <>
                    <div><dt>SETTLEMENT</dt><dd>{managedBond.state.settlement}</dd></div>
                    <div><dt>OUTCOME</dt><dd>{managedBond.state.outcome}</dd></div>
                    <div><dt>LOCKED</dt><dd>{managedBond.state.locked_amount_wei.toString()} wei</dd></div>
                    <div><dt>PAYOUT RECIPIENT</dt><dd>{managedBond.state.payout_recipient}</dd></div>
                    {managedBond.state.reasoning ? <div><dt>REASONING</dt><dd>{managedBond.state.reasoning}</dd></div> : null}
                    {managedBond.state.decisive_evidence ? <div><dt>DECISIVE EVIDENCE</dt><dd>{managedBond.state.decisive_evidence}</dd></div> : null}
                  </>
                ) : (
                  <div><dt>ONCHAIN STATE</dt><dd>Loading the latest finalized state…</dd></div>
                )}
              </dl>
              {managedRecord.pendingAction ? (
                <div className="pb-submission-status pending" role="status">
                  <span><i /> Lifecycle transaction saved</span>
                  <p>{actionLabel(managedRecord.pendingAction.functionName)} is awaiting reconciliation: {shortTransaction(managedRecord.pendingAction.transactionId)}. Do not submit the action again.</p>
                </div>
              ) : null}
              {managedRecord.lastFailedTransaction?.kind === "action" ? (
                <div className="pb-submission-status warning" role="status">
                  <span><i /> Previous lifecycle action finalized unsuccessfully</span>
                  <p>The proven failed hash was cleared from pending state and can be retried: {shortTransaction(managedRecord.lastFailedTransaction.transactionId)}.</p>
                </div>
              ) : null}
              {managedBond && managedActions.length === 0 && !managedRecord.pendingAction ? (
                <div className="pb-submission-status complete" role="status">
                  <span><i /> No lifecycle action is currently available</span>
                  <p>The next action appears only after the relevant funding, resolution, unresolved, or stale deadline.</p>
                </div>
              ) : null}
              {managedBond?.state.settlement === "UNFUNDED" && managedRecord.stage === "deployed_unfunded" ? (
                <div className="pb-submission-status warning">
                  <span><i /> Contract is not funded</span>
                  <p>{managedCanFund
                    ? "Return to the saved pre-sign review to fund the exact immutable amount. No principal is locked yet."
                    : "The funding deadline has passed. Expire the unfunded contract; no principal was ever locked."}</p>
                </div>
              ) : null}
              {managementError ? <p className="pb-submission-error" role="alert">{managementError}</p> : null}
            </div>
            <footer>
              <button className="pb-button quiet" onClick={() => void openBond(managedRecord)} type="button">Refresh finalized state</button>
              {walletRpcRepairRequired ? (
                <button
                  className="pb-button primary"
                  disabled={walletRpcRepairPending}
                  onClick={() => void repairWalletRpc()}
                  type="button"
                >
                  {walletRpcRepairPending ? "Updating wallet network…" : "Use official chain 4221 RPC"}
                </button>
              ) : null}
              {managedRecord.pendingAction ? (
                <button
                  className="pb-button primary"
                  disabled={managementPending}
                  onClick={() => void reconcileSavedOperation(managedRecord)}
                  type="button"
                >
                  {managementPending ? "Waiting for finality" : "Reconcile saved action"}
                </button>
              ) : null}
              {managedCanFund && managedRecord.stage === "deployed_unfunded" ? (
                <button
                  className="pb-button primary"
                  onClick={() => {
                    setCurrentOperationId(managedRecord.id);
                    setManagedRecordId(undefined);
                    setReviewOpen(true);
                  }}
                  type="button"
                >
                  Review funding
                </button>
              ) : null}
              {managedActions.map((action) => (
                <button
                  className="pb-button primary"
                  disabled={!account.isConnected || wrongNetwork || managementPending}
                  key={action}
                  onClick={() => void runBondAction(action)}
                  type="button"
                >
                  {managementPending ? "Waiting for finality" : actionLabel(action)}
                </button>
              ))}
            </footer>
          </section>
        </div>
      ) : null}
    </main>
  );
}
