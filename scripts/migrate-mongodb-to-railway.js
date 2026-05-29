import dotenv from "dotenv";
import { MongoClient } from "mongodb";

dotenv.config();

const parseCsv = (value) =>
  String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

const sourceUri = process.env.SOURCE_MONGODB_URI || process.env.MONGODB_URI;
const targetUri = process.env.TARGET_MONGODB_URI || process.env.RAILWAY_MONGO_URL || process.env.MONGO_URL;
const sourceDbName = process.env.SOURCE_MONGODB_DB || process.env.MONGODB_SOURCE_DB || process.env.MONGODB_DB_NAME || "fares";
const targetDbName = process.env.TARGET_MONGODB_DB || process.env.MONGODB_TARGET_DB || "fares";
const batchSize = Number(process.env.MONGODB_MIGRATION_BATCH_SIZE || 500);
const targetIndexMinFreeDiskMb = Number(process.env.TARGET_INDEX_MIN_FREE_DISK_MB || 0);
const confirmMigration = process.env.CONFIRM_MONGODB_MIGRATION === "1";
const dryRun = process.env.DRY_RUN === "1" || !confirmMigration;
const mode = process.env.MIGRATION_MODE || "replace";
const includeCollections = parseCsv(process.env.COLLECTIONS);
const excludeCollections = new Set(["system.profile", ...parseCsv(process.env.EXCLUDE_COLLECTIONS)]);

if (!sourceUri) {
  console.error("Missing SOURCE_MONGODB_URI or MONGODB_URI for source database.");
  process.exit(1);
}

if (!targetUri) {
  console.error("Missing TARGET_MONGODB_URI, RAILWAY_MONGO_URL, or MONGO_URL for Railway target database.");
  process.exit(1);
}

if (mode !== "replace") {
  console.error('Only MIGRATION_MODE="replace" is supported. This avoids partial/stale target data.');
  process.exit(1);
}

const mongoIdentity = (uri, dbName) => {
  try {
    const parsed = new URL(uri);
    const database = parsed.pathname && parsed.pathname !== "/" ? decodeURIComponent(parsed.pathname.slice(1)) : dbName;
    return [parsed.protocol, parsed.hostname, parsed.port || "", parsed.username || "", database].join("|");
  } catch {
    return String(uri) + "|" + dbName;
  }
};

if (mongoIdentity(sourceUri, sourceDbName) === mongoIdentity(targetUri, targetDbName) && process.env.ALLOW_SAME_MONGODB_TARGET !== "1") {
  console.error("Source and target MongoDB look identical. Set ALLOW_SAME_MONGODB_TARGET=1 only if this is intentional.");
  process.exit(1);
}

const redactUri = (uri) => String(uri).replace(/:\/\/([^:]+):([^@]+)@/, "://[user]:[password]@");

const configureTargetIndexBuildDisk = async (targetClient) => {
  if (!targetIndexMinFreeDiskMb || dryRun) return;

  try {
    await targetClient.db("admin").command({
      setParameter: 1,
      indexBuildMinAvailableDiskSpaceMB: targetIndexMinFreeDiskMb,
    });
    console.log("Target index min free disk set to " + targetIndexMinFreeDiskMb + " MB");
  } catch (error) {
    console.warn("  ! Could not adjust target index disk threshold: " + error.message);
  }
};

const copyIndexes = async (sourceCollection, targetCollection) => {
  const indexes = await sourceCollection.indexes().catch(() => []);

  for (const index of indexes) {
    if (index.name === "_id_") continue;

    const { key, v, ns, ...options } = index;
    try {
      await targetCollection.createIndex(key, options);
    } catch (error) {
      console.warn("  ! Could not create index " + index.name + ": " + error.message);
    }
  }
};

const copyCollection = async (sourceDb, targetDb, name) => {
  const sourceCollection = sourceDb.collection(name);
  const targetCollection = targetDb.collection(name);
  const sourceCount = await sourceCollection.estimatedDocumentCount();

  if (dryRun) {
    console.log("- " + name + ": " + sourceCount + " docs (dry-run)");
    return { name, sourceCount, copied: 0 };
  }

  const targetCollections = await targetDb.listCollections({ name }, { nameOnly: true }).toArray();
  if (targetCollections.length > 0) {
    await targetCollection.drop();
  }
  await targetDb.createCollection(name).catch((error) => {
    if (error.codeName !== "NamespaceExists") throw error;
  });

  let copied = 0;
  let batch = [];
  const cursor = sourceCollection.find({}).batchSize(batchSize);

  try {
    for await (const doc of cursor) {
      batch.push(doc);
      if (batch.length >= batchSize) {
        await targetDb.collection(name).insertMany(batch, { ordered: false });
        copied += batch.length;
        batch = [];
      }
    }

    if (batch.length > 0) {
      await targetDb.collection(name).insertMany(batch, { ordered: false });
      copied += batch.length;
    }
  } finally {
    await cursor.close().catch(() => undefined);
  }

  await copyIndexes(sourceCollection, targetDb.collection(name));
  console.log("- " + name + ": copied " + copied + "/" + sourceCount + " docs");
  return { name, sourceCount, copied };
};

const run = async () => {
  console.log("MongoDB migration to Railway");
  console.log("Source: " + redactUri(sourceUri) + " / " + sourceDbName);
  console.log("Target: " + redactUri(targetUri) + " / " + targetDbName);
  console.log("Mode: " + (dryRun ? "dry-run" : mode));

  if (dryRun) {
    console.log("Set CONFIRM_MONGODB_MIGRATION=1 to execute the replacement migration.");
  }

  const sourceClient = new MongoClient(sourceUri, { serverSelectionTimeoutMS: 10000 });
  const targetClient = new MongoClient(targetUri, { serverSelectionTimeoutMS: 10000 });

  try {
    await sourceClient.connect();
    await targetClient.connect();
    await configureTargetIndexBuildDisk(targetClient);

    const sourceDb = sourceClient.db(sourceDbName);
    const targetDb = targetClient.db(targetDbName);

    const sourceCollections = await sourceDb.listCollections({}, { nameOnly: true }).toArray();
    const collectionNames = sourceCollections
      .map((collection) => collection.name)
      .filter((name) => !name.startsWith("system."))
      .filter((name) => includeCollections.length === 0 || includeCollections.includes(name))
      .filter((name) => !excludeCollections.has(name))
      .sort((a, b) => a.localeCompare(b));

    if (collectionNames.length === 0) {
      console.log("No collections to migrate.");
      return;
    }

    const results = [];
    for (const name of collectionNames) {
      results.push(await copyCollection(sourceDb, targetDb, name));
    }

    const totalSource = results.reduce((sum, item) => sum + item.sourceCount, 0);
    const totalCopied = results.reduce((sum, item) => sum + item.copied, 0);
    console.log("Done. Collections: " + results.length + ". Source docs: " + totalSource + ". Copied docs: " + totalCopied + ".");
  } finally {
    await sourceClient.close().catch(() => undefined);
    await targetClient.close().catch(() => undefined);
  }
};

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
