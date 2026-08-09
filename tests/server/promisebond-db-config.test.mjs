import assert from "node:assert/strict";
import test from "node:test";
import {
  ensurePromiseBondIndexes,
  getPromiseBondDb,
  getPromiseBondDatabaseName,
  isPromiseBondMongoConfigured
} from "../../server/promisebond/db.js";

test("PromiseBond database configuration never falls back to BackIt variables", () => {
  const previousPromiseBondName = process.env.PROMISEBOND_MONGODB_DB_NAME;
  const previousPromiseBondUri = process.env.PROMISEBOND_MONGODB_URI;
  const previousBackItName = process.env.MONGODB_DB_NAME;
  const previousBackItUri = process.env.MONGODB_URI;

  try {
    delete process.env.PROMISEBOND_MONGODB_DB_NAME;
    delete process.env.PROMISEBOND_MONGODB_URI;
    process.env.MONGODB_DB_NAME = "backit";
    process.env.MONGODB_URI = "mongodb://backit.invalid/backit";

    assert.equal(getPromiseBondDatabaseName(), "promisebond");
    assert.equal(isPromiseBondMongoConfigured(), false);

    process.env.PROMISEBOND_MONGODB_DB_NAME = "promisebond_staging";
    process.env.PROMISEBOND_MONGODB_URI = "mongodb://promisebond.invalid/promisebond";
    assert.equal(getPromiseBondDatabaseName(), "promisebond_staging");
    assert.equal(isPromiseBondMongoConfigured(), true);
  } finally {
    if (previousPromiseBondName === undefined) delete process.env.PROMISEBOND_MONGODB_DB_NAME;
    else process.env.PROMISEBOND_MONGODB_DB_NAME = previousPromiseBondName;
    if (previousPromiseBondUri === undefined) delete process.env.PROMISEBOND_MONGODB_URI;
    else process.env.PROMISEBOND_MONGODB_URI = previousPromiseBondUri;
    if (previousBackItName === undefined) delete process.env.MONGODB_DB_NAME;
    else process.env.MONGODB_DB_NAME = previousBackItName;
    if (previousBackItUri === undefined) delete process.env.MONGODB_URI;
    else process.env.MONGODB_URI = previousBackItUri;
  }
});

test("PromiseBond database isolation fails closed at runtime", async (t) => {
  const names = [
    "PROMISEBOND_MONGODB_DB_NAME",
    "PROMISEBOND_MONGODB_URI",
    "MONGODB_URI"
  ];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));

  try {
    await t.test("BackIt database name is forbidden", async () => {
      process.env.PROMISEBOND_MONGODB_DB_NAME = " BackIt ";
      process.env.PROMISEBOND_MONGODB_URI = "mongodb://promisebond.invalid/promisebond";
      process.env.MONGODB_URI = "mongodb://backit.invalid/backit";
      assert.throws(() => getPromiseBondDatabaseName(), /BackIt database name is forbidden/);
      assert.throws(() => isPromiseBondMongoConfigured(), /BackIt database name is forbidden/);
      await assert.rejects(getPromiseBondDb(), /BackIt database name is forbidden/);
    });

    await t.test("generic BackIt URI cannot be reused", async () => {
      process.env.PROMISEBOND_MONGODB_DB_NAME = "promisebond_staging";
      process.env.PROMISEBOND_MONGODB_URI = "mongodb://shared.invalid/data";
      process.env.MONGODB_URI = "mongodb://shared.invalid/data";
      assert.throws(() => isPromiseBondMongoConfigured(), /must differ from MONGODB_URI/);
      await assert.rejects(getPromiseBondDb(), /must differ from MONGODB_URI/);
    });
  } finally {
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
});

test("PromiseBond native indexes use GenLayer contract identity and contain no bridge schema", async () => {
  const calls = [];
  const database = {
    collection(name) {
      return {
        async createIndexes(indexes) {
          calls.push({ indexes, name });
        }
      };
    }
  };

  await ensurePromiseBondIndexes(database);

  const collectionNames = calls.map(({ name }) => name);
  assert.ok(collectionNames.includes("promise_bonds"));
  assert.ok(collectionNames.includes("promisebond_transactions"));
  assert.ok(collectionNames.includes("promisebond_evidence_blobs"));
  assert.ok(collectionNames.includes("promisebond_evidence_observations"));
  assert.equal(collectionNames.some((name) => /bridge|base|escrow|usdc/i.test(name)), false);

  const bondIndexes = calls.find(({ name }) => name === "promise_bonds").indexes;
  assert.deepEqual(bondIndexes[0], {
    key: { network: 1, contractAddress: 1 },
    name: "promise_bonds_network_contract_unique",
    unique: true
  });

  const serialized = JSON.stringify(calls);
  assert.doesNotMatch(serialized, /escrowAddress|transactionHash|logIndex|bondId/);
});
