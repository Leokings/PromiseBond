import { MongoClient, ServerApiVersion } from "mongodb";

const DEFAULT_PROMISEBOND_DB_NAME = "promisebond";

let client;
let connectionPromise;

function optionalEnv(name) {
  const value = process.env[name]?.trim();
  return value || undefined;
}

function getValidatedPromiseBondDatabaseConfig() {
  const databaseName = optionalEnv("PROMISEBOND_MONGODB_DB_NAME") || DEFAULT_PROMISEBOND_DB_NAME;
  const uri = optionalEnv("PROMISEBOND_MONGODB_URI");
  const genericUri = optionalEnv("MONGODB_URI");

  if (databaseName.toLowerCase() === "backit") {
    throw new Error("PromiseBond database isolation failed: BackIt database name is forbidden");
  }
  if (uri && genericUri && uri === genericUri) {
    throw new Error("PromiseBond database isolation failed: PROMISEBOND_MONGODB_URI must differ from MONGODB_URI");
  }
  return { databaseName, uri };
}

export function isPromiseBondMongoConfigured() {
  return Boolean(getValidatedPromiseBondDatabaseConfig().uri);
}

export function getPromiseBondDatabaseName() {
  return getValidatedPromiseBondDatabaseConfig().databaseName;
}

export async function getPromiseBondDb() {
  const { databaseName, uri } = getValidatedPromiseBondDatabaseConfig();
  if (!uri) return undefined;

  if (!connectionPromise) {
    client = new MongoClient(uri, {
      connectTimeoutMS: 10_000,
      maxConnecting: 2,
      maxIdleTimeMS: 60_000,
      maxPoolSize: 10,
      serverApi: {
        deprecationErrors: true,
        strict: false,
        version: ServerApiVersion.v1
      },
      serverSelectionTimeoutMS: 10_000,
      socketTimeoutMS: 30_000
    });
    connectionPromise = client.connect()
      .then(async () => {
        const database = client.db(databaseName);
        await ensurePromiseBondIndexes(database);
        return database;
      })
      .catch((error) => {
        client = undefined;
        connectionPromise = undefined;
        throw error;
      });
  }

  return connectionPromise;
}

export async function closePromiseBondDb() {
  if (client) await client.close();
  client = undefined;
  connectionPromise = undefined;
}

export async function ensurePromiseBondIndexes(database) {
  await Promise.all([
    database.collection("promise_bonds").createIndexes([
      {
        key: { network: 1, contractAddress: 1 },
        name: "promise_bonds_network_contract_unique",
        unique: true
      },
      {
        key: { network: 1, createdAt: -1, contractAddress: 1 },
        name: "promise_bonds_public_created"
      },
      {
        key: { network: 1, creatorAddress: 1, createdAt: -1, contractAddress: 1 },
        name: "promise_bonds_network_creator_created"
      },
      { key: { creatorAddress: 1, createdAt: -1 }, name: "promise_bonds_creator_created" },
      { key: { beneficiaryAddress: 1, createdAt: -1 }, name: "promise_bonds_beneficiary_created" },
      { key: { status: 1, deadline: 1 }, name: "promise_bonds_status_deadline" }
    ]),
    database.collection("promisebond_transactions").createIndexes([
      {
        key: { network: 1, transactionId: 1 },
        name: "promisebond_transactions_network_tx_unique",
        unique: true
      },
      { key: { contractAddress: 1, finalizedAt: -1 }, name: "promisebond_transactions_contract_finalized" },
      { key: { method: 1, finalizedAt: -1 }, name: "promisebond_transactions_method_finalized" }
    ]),
    database.collection("promisebond_chain_cursors").createIndexes([
      {
        key: { network: 1, worker: 1 },
        name: "promisebond_chain_cursors_network_worker_unique",
        unique: true
      }
    ]),
    database.collection("promisebond_jobs").createIndexes([
      { key: { jobId: 1 }, name: "promisebond_jobs_job_id_unique", unique: true },
      { key: { status: 1, runAfter: 1, priority: -1 }, name: "promisebond_jobs_ready_queue" },
      {
        key: { type: 1, network: 1, status: 1, runAfter: 1, attempts: 1, priority: -1, createdAt: 1 },
        name: "promisebond_jobs_reconcile_ready"
      },
      {
        key: { type: 1, network: 1, status: 1, leaseExpiresAt: 1, attempts: 1 },
        name: "promisebond_jobs_reconcile_expired"
      },
      { key: { leaseExpiresAt: 1 }, name: "promisebond_jobs_lease_expiry" }
    ]),
    database.collection("promisebond_evidence_blobs").createIndexes([
      { key: { algorithm: 1, digest: 1 }, name: "promisebond_evidence_blobs_digest_unique", unique: true }
    ]),
    database.collection("promisebond_evidence_observations").createIndexes([
      {
        key: { network: 1, contractAddress: 1, sourceUrl: 1, observedAt: -1 },
        name: "promisebond_evidence_observations_contract_source"
      },
      { key: { blobDigest: 1, observedAt: -1 }, name: "promisebond_evidence_observations_blob" }
    ]),
    database.collection("promisebond_evidence_preflight_quotas").createIndexes([
      {
        key: { bucketId: 1 },
        name: "promisebond_evidence_preflight_quotas_bucket_unique",
        unique: true
      },
      {
        key: { expiresAt: 1 },
        name: "promisebond_evidence_preflight_quotas_expiry",
        expireAfterSeconds: 0
      }
    ]),
    database.collection("promisebond_deployments").createIndexes([
      {
        key: { network: 1, contractAddress: 1 },
        name: "promisebond_deployments_network_contract_unique",
        unique: true
      },
      { key: { release: 1, createdAt: -1 }, name: "promisebond_deployments_release_created" }
    ]),
    database.collection("promisebond_audit_events").createIndexes([
      { key: { eventId: 1 }, name: "promisebond_audit_events_id_unique", unique: true },
      { key: { contractAddress: 1, createdAt: -1 }, name: "promisebond_audit_events_contract_created" },
      { key: { type: 1, createdAt: -1 }, name: "promisebond_audit_events_type_created" }
    ])
  ]);
}
