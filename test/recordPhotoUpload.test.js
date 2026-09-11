import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRecordPhotoUpload } from "../src/recordPhotoUpload.js";

async function setup(t, overrides = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "fares-photo-test-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "photo.jpg");
  await fs.copyFile(new URL(import.meta.url), filePath);
  const record = {
    numCert: 1234,
    serial: "ABC-123",
    inspeccionCompleta: { conexionesAccesorios: { accesorios: [{ id: "valve-1" }] } },
    storage: {
      rootFolderId: "existing-root",
      registrosFotograficosFolderId: "existing-photos",
      sectionFolders: { roscas_conexiones: "existing-accessories", superficie: "existing-surface" },
    },
    ...overrides,
  };
  const calls = [];
  const collection = {
    findOne: async () => record,
    updateOne: async (...args) => { calls.push(["update", ...args]); return { matchedCount: 1 }; },
  };
  const driveService = {
    ensureCertificateFolderTree: async (...args) => {
      calls.push(["tree", ...args]);
      return { rootFolderId: "new-root", registrosFotograficosFolderId: "new-photos", sectionFolders: {} };
    },
    ensureFolder: async (...args) => { calls.push(["folder", ...args]); return { id: "repaired-photos" }; },
    ensurePhotoSectionFolder: async (...args) => { calls.push(["section", ...args]); return { id: "new-accessories" }; },
    getDriveFolders: async () => { calls.push(["legacy"]); return { INF: "legacy-informes" }; },
    uploadFile: async (...args) => { calls.push(["upload", ...args]); return { id: "drive-photo", webViewLink: "https://example.test/photo" }; },
    getThumbnailUrl: (id) => `https://example.test/thumbnail/${id}`,
    deleteFile: async (...args) => { calls.push(["delete", ...args]); },
  };
  const upload = createRecordPhotoUpload({
    connect: async () => ({ collection: (name) => { calls.push(["collection", name]); return collection; } }),
    driveService,
    cacheService: { clear: (key) => calls.push(["cache", key]), clearPrefix: (key) => calls.push(["cachePrefix", key]) },
    getSectionName: () => "Roscas, Conexiones y Accesorios",
    parentFolderId: "legacy-parent",
  });
  const req = {
    params: { id: "507f1f77bcf86cd799439011" },
    body: { category: "roscas_conexiones", description: "acc:valve-1" },
    file: { path: filePath, mimetype: "image/jpeg", originalname: "camera.jpg" },
  };
  const res = { status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
  return { record, calls, collection, driveService, req, res, run: (name = "certificates") => upload(name, req, res) };
}

for (const collectionName of ["drafts", "certificates"]) {
  test(`${collectionName}: reuses the saved Drive tree and preserves the accessory association`, async (t) => {
    const { run, calls, res, req } = await setup(t);
    await run(collectionName);
    const upload = calls.find(([name]) => name === "upload")[1];
    assert.equal(upload.folderId, "existing-accessories");
    assert.match(upload.fileName, /^FOTO_ABC-123_roscas_conexiones_\d+\.jpg$/);
    assert.deepEqual(upload.appProperties, { NumCert: "1234", Serial: "ABC-123", Category: "roscas_conexiones" });
    assert.equal(calls.some(([name]) => ["tree", "folder", "section", "legacy"].includes(name)), false);
    assert.equal(res.statusCode, 201);
    assert.equal(res.body.description, "acc:valve-1");
    assert.equal(res.body.driveFileId, "drive-photo");
    assert.equal(res.body.includeInPdf, true);
    const updates = calls.find(([name]) => name === "update")[2][0].$set;
    assert.deepEqual(updates.fotos.$concatArrays[0], { $ifNull: ["$fotos", []] });
    assert.deepEqual(updates.fotos.$concatArrays[1].$literal, [res.body]);
    assert.deepEqual(updates.storage.$mergeObjects[2].sectionFolders.$mergeObjects[0], { $ifNull: ["$storage.sectionFolders", {}] });
    assert.ok(calls.some(([name, key]) => name === "cache" && key === `all_${collectionName}`));
    await assert.rejects(fs.access(req.file.path), { code: "ENOENT" });
  });
}

test("creates the numbered tree and category folder when storage is absent; PNG keeps its extension", async (t) => {
  const { run, calls, req } = await setup(t, { storage: null });
  req.file.mimetype = "image/png";
  await run();
  assert.deepEqual(calls.find(([name]) => name === "tree"), ["tree", 1234]);
  assert.deepEqual(calls.find(([name]) => name === "section"), ["section", "new-photos", "Roscas, Conexiones y Accesorios"]);
  const uploaded = calls.find(([name]) => name === "upload")[1];
  assert.equal(uploaded.folderId, "new-accessories");
  assert.match(uploaded.fileName, /\.png$/);
  assert.equal(uploaded.mimeType, "image/png");
});

test("repairs a partial tree under its existing root", async (t) => {
  const { run, calls } = await setup(t, { storage: { rootFolderId: "original-root" } });
  await run();
  assert.deepEqual(calls.find(([name]) => name === "folder"), ["folder", "Registros fotográficos", "original-root"]);
  assert.deepEqual(calls.find(([name]) => name === "section"), ["section", "repaired-photos", "Roscas, Conexiones y Accesorios"]);
  assert.equal(calls.some(([name]) => name === "tree"), false);
});

test("a Drive folder failure never falls back to the general folder or saves a phantom photo", async (t) => {
  const { run, calls, driveService, req } = await setup(t, { storage: null });
  driveService.ensureCertificateFolderTree = async () => { throw new Error("Drive unavailable"); };
  await assert.rejects(run(), { statusCode: 502, code: "PHOTO_UPLOAD_FAILED" });
  assert.equal(calls.some(([name]) => ["legacy", "upload", "update"].includes(name)), false);
  await assert.rejects(fs.access(req.file.path), { code: "ENOENT" });
});

test("a failed upload does not write photo metadata", async (t) => {
  const { run, calls, driveService } = await setup(t);
  driveService.uploadFile = async () => { throw new Error("Upload rejected"); };
  await assert.rejects(run(), { statusCode: 502 });
  assert.equal(calls.some(([name]) => name === "update"), false);
});

test("a missing Drive file ID is treated as failure", async (t) => {
  const { run, calls, driveService } = await setup(t);
  driveService.uploadFile = async () => ({});
  await assert.rejects(run(), { statusCode: 502 });
  assert.equal(calls.some(([name]) => name === "update"), false);
});

test("removes the newly uploaded file if saving the record fails", async (t) => {
  const { run, calls, collection } = await setup(t);
  collection.updateOne = async () => { throw new Error("DB unavailable"); };
  await assert.rejects(run(), { statusCode: 502 });
  assert.deepEqual(calls.find(([name]) => name === "delete"), ["delete", "drive-photo"]);
});

test("non-consecutive visits keep the existing mobile destination", async (t) => {
  const { run, calls } = await setup(t, { storage: null, numCert: null, noConsecutive: true });
  await run("drafts");
  assert.equal(calls.find(([name]) => name === "upload")[1].folderId, "legacy-informes");
  assert.equal(calls.some(([name]) => name === "tree"), false);
});

for (const [label, change, expectedCode] of [
  ["non-image file", (ctx) => { ctx.req.file.mimetype = "application/pdf"; }, "INVALID_PHOTO_TYPE"],
  ["invalid category", (ctx) => { ctx.req.body.category = "invalid.category"; }, "INVALID_PHOTO_CATEGORY"],
  ["missing accessory", (ctx) => { ctx.req.body.description = "acc:missing"; }, "INVALID_ACCESSORY"],
  ["wrong accessory category", (ctx) => { ctx.req.body.category = "superficie"; }, "INVALID_ACCESSORY"],
]) {
  test(`rejects ${label} and cleans up the temporary file`, async (t) => {
    const ctx = await setup(t);
    change(ctx);
    await assert.rejects(ctx.run(), { statusCode: 400, code: expectedCode });
    assert.equal(ctx.calls.some(([name]) => ["upload", "update"].includes(name)), false);
    await assert.rejects(fs.access(ctx.req.file.path), { code: "ENOENT" });
  });
}
