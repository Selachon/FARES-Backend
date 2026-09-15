import express from "express";
import multer from "multer";
import crypto from "node:crypto";
import path from "node:path";
import fs from "node:fs/promises";
import { authenticate } from "../middleware.js";
import { inventoryAccessGuard } from "../inventoryAccess.js";
import { asyncHandler, createError } from "../utils.js";
import { tankService } from "../tankService.js";
import { colombia, assertAdmin } from "../inventoryModel.js";
import { driveService } from "../driveService.js";

const router = express.Router();
const storage = path.resolve(
  process.env.INVENTORY_PHOTO_DIR || "uploads/inventory",
);
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024, files: 1 },
});
router.use(authenticate, inventoryAccessGuard);
const handle = (fn) =>
  asyncHandler(async (req, res) => res.json(await fn(req)));
router.get(
  "/summary",
  handle((req) => tankService.summary(req.user, req.query)),
);
router.get(
  "/options",
  handle((req) => tankService.options(req.user)),
);
router.get(
  "/map",
  handle((req) => tankService.map(req.user, req.query)),
);
router.get(
  "/colombia",
  handle(() => colombia),
);
router.get(
  "/events",
  handle((req) => tankService.events(req.user, req.query)),
);
router.get(
  "/reconciliation",
  handle((req) => tankService.conflicts(req.user)),
);
router.post(
  "/reconciliation/run",
  handle((req) => tankService.reconcileAll(req.user)),
);
router.post(
  "/reconciliation/:id/resolve",
  handle((req) => tankService.resolve(req.params.id, req.body, req.user)),
);
router.get(
  "/tanks",
  handle((req) => tankService.list(req.user, req.query)),
);
router.post(
  "/tanks",
  asyncHandler(async (req, res) =>
    res.status(201).json(await tankService.create(req.body, req.user)),
  ),
);
router.get(
  "/tanks/:id",
  handle((req) => tankService.detail(req.params.id, req.user)),
);
router.patch(
  "/tanks/:id",
  handle((req) => tankService.update(req.params.id, req.body, req.user)),
);
router.post(
  "/tanks/:id/events",
  handle((req) => tankService.movement(req.params.id, req.body, req.user)),
);
router.get(
  "/tanks/:id/events",
  handle((req) =>
    tankService.events(req.user, { ...req.query, tankId: req.params.id }),
  ),
);
router.get(
  "/tanks/:id/certificates",
  handle(
    async (req) =>
      (await tankService.detail(req.params.id, req.user)).certificates,
  ),
);
router.get(
  "/tanks/:id/photos",
  handle((req) => tankService.photos(req.params.id, req.user)),
);
router.put(
  "/tanks/:id/cover",
  handle((req) => tankService.cover(req.params.id, req.body, req.user)),
);
router.post(
  "/tanks/:id/photos",
  (req, res, next) => {
    try {
      assertAdmin(req.user);
      next();
    } catch (e) {
      next(e);
    }
  },
  upload.single("photo"),
  asyncHandler(async (req, res) => {
    const file = req.file;
    const jpeg = file?.buffer?.[0] === 0xff && file?.buffer?.[1] === 0xd8;
    const png = file?.buffer
      ?.subarray(0, 8)
      .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    if (!file || (!jpeg && !png))
      throw createError("Carga una imagen JPG o PNG de hasta 8 MB", 400);
    await tankService.raw(req.params.id, req.user);
    const id = crypto.randomUUID();
    // Persist uploads with their tank metadata in MongoDB. Railway's container
    // filesystem is ephemeral and must only hold the historical-photo cache.
    await tankService.addPhoto(
        req.params.id,
        {
          id,
          category: "area_inspeccion",
          storage: "mongodb",
          mimeType: jpeg ? "image/jpeg" : "image/png",
          createdAt: new Date(),
        },
        req.user,
        file.buffer,
      );
    res.status(201).json({ id });
  }),
);
router.get(
  "/tanks/:id/photos/:photoId/image",
  asyncHandler(async (req, res) => {
    const photo = await tankService.photoSource(
      req.params.id,
      req.params.photoId,
      req.query.certificateId,
      req.user,
    );
    res.set("Cache-Control", "private, max-age=120");
    if (photo.storage === "mongodb") {
      const db = await tankService.db();
      const stored = await db.collection("inventory_photo_files").findOne({
        _id: photo.id, tankId: req.params.id,
      });
      if (!stored?.bytes) throw createError("Imagen no disponible", 404);
      return res.type(stored.mimeType).send(Buffer.from(stored.bytes.buffer));
    }
    if (photo.fileName) {
      return res
        .type(photo.mimeType)
        .send(
          await fs.readFile(path.join(storage, path.basename(photo.fileName))),
        );
    }
    if (!/^[a-zA-Z0-9_-]+$/.test(photo.driveFileId || ""))
      throw createError("Imagen no disponible", 404);
    // Authorization precedes the cache lookup. Files never become public through this endpoint.
    const cacheDir = path.join(storage, "cache");
    await fs.mkdir(cacheDir, { recursive: true });
    const filePath = path.join(cacheDir, `${photo.driveFileId}.jpg`);
    let bytes = await fs.readFile(filePath).catch(() => null);
    if (!bytes) {
      const response = await fetch(
        `https://drive.google.com/thumbnail?id=${photo.driveFileId}&sz=w1200`,
        { signal: AbortSignal.timeout(20000) },
      );
      if (
        response.ok &&
        response.headers.get("content-type")?.startsWith("image/")
      )
        bytes = Buffer.from(await response.arrayBuffer());
      else {
        const dataUri = await driveService.getFileDataUri(photo.driveFileId);
        if (dataUri?.startsWith("data:image/"))
          bytes = Buffer.from(dataUri.split(",")[1], "base64");
      }
      if (!bytes)
        throw createError(
          "No fue posible cargar la imagen. Puedes reintentar.",
          502,
        );
      await fs.writeFile(filePath, bytes);
    }
    res.type("image/jpeg").send(bytes);
  }),
);
export default router;
