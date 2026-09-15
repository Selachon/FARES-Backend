// Persistent, isolated local preview. The source database is read only here.
import dotenv from "dotenv";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { MongoClient } from "mongodb";
import { MongoMemoryReplSet } from "mongodb-memory-server";
dotenv.config();
const sourceUri = process.env.MONGODB_URI || process.env.MONGO_URL;
const root = path.resolve(".local-inventory");
await fs.mkdir(path.join(root, "db"), { recursive: true, mode: 0o700 });
const repl = await MongoMemoryReplSet.create({
  instanceOpts: [{ port: 27028, dbPath: path.join(root, "db") }],
  replSet: {
    name: "faresLocal",
    count: 1,
    storageEngine: "wiredTiger",
    ip: "127.0.0.1",
  },
});
const localUri = repl.getUri();
const local = new MongoClient(localUri);
await local.connect();
const db = local.db("fares_inventory_local");
if (!(await db.collection("local_meta").findOne({ _id: "source-copy" }))) {
  const source = new MongoClient(sourceUri, {
    serverSelectionTimeoutMS: 10000,
  });
  await source.connect();
  try {
    for (const name of [
      "certificates",
      "users",
      "companies",
      "inventory_sites",
      "drafts",
    ]) {
      const docs = await source.db("fares").collection(name).find({}).toArray();
      if (docs.length)
        await db
          .collection(name)
          .bulkWrite(
            docs.map((d) => ({
              replaceOne: {
                filter: { _id: d._id },
                replacement: d,
                upsert: true,
              },
            })),
          );
      console.log(`Local copy: ${name}, ${docs.length} documents`);
    }
    await db
      .collection("local_meta")
      .insertOne({ _id: "source-copy", createdAt: new Date() });
  } finally {
    await source.close();
  }
}
const examples = await db
  .collection("certificates")
  .find(
    { numCert: { $in: [3655, 3654, 3653] } },
    {
      projection: {
        numCert: 1,
        serial: 1,
        empresa: 1,
        "inspeccionCompleta.informacionItem": 1,
      },
    },
  )
  .toArray();
console.log(
  "Local example certificates:",
  examples.map((c) => `${c.numCert}: ${c.serial}`).join(", "),
);
await local.close();
let secret;
try {
  secret = await fs.readFile(path.join(root, "jwt-secret"), "utf8");
} catch {
  secret = crypto.randomBytes(48).toString("hex");
  await fs.writeFile(path.join(root, "jwt-secret"), secret, { mode: 0o600 });
}
Object.assign(process.env, {
  MONGODB_URI: localUri,
  MONGO_URL: localUri,
  MONGODB_LOCAL_DB: "fares_inventory_local",
  MONGODB_TLS: "0",
  LOCAL_DEV: "1",
  LOCAL_PREVIEW: "1",
  NODE_ENV: "development",
  JWT_SECRET: secret,
  PORT: process.env.LOCAL_API_PORT || "3015",
  HOST: "127.0.0.1",
  SEED_DEMO: "0",
  INVENTORY_PHOTO_DIR: path.join(root, "photos"),
});
delete process.env.RAILWAY_ENVIRONMENT;
delete process.env.RAILWAY_SERVICE_ID;
const { tankService } = await import("../src/tankService.js");
console.log(
  "Inventory initial reconciliation:",
  await tankService.reconcileAll({ role: "ADMIN", username: "local-import" }),
);
await import("../src/index.js");
// Reconcile imports that bypass certificateService. Fingerprints make retries idempotent.
let busy = false;
const timer = setInterval(async () => {
  if (busy) return;
  busy = true;
  try {
    await tankService.reconcileAll({ role: "ADMIN", username: "local-sync" });
  } finally {
    busy = false;
  }
}, 60000);
timer.unref();
process.on("exit", () => {
  clearInterval(timer);
});
console.log(
  "Local preview ready: API on 127.0.0.1:3015; all writes use the local database.",
);
