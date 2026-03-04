// Main REST API router for auth, certificates, drafts, admin, and app endpoints.
import express from "express";
import multer from "multer";
import rateLimit from "express-rate-limit";
import jwt from "jsonwebtoken";
import { config } from "../config.js";
import { asyncHandler, logger } from "../utils.js";
import { emailService } from "../emailService.js";
import { userService } from "../userService.js";
import { certificateService } from "../certificateService.js";
import { configService } from "../configService.js";
import { draftService } from "../draftService.js";
import { adminGuard, healthMiddleware, userGuard, appGuard, authenticate } from "../middleware.js";
import { notificationService } from "../notificationService.js";
import { notificationInboxService } from "../notificationInboxService.js";
import { buildCertificateCreatedPayload } from "../notificationPayload.js";
import { performanceMonitor } from "../performanceMonitor.js";
import { connect } from "../db.js";
import { companyService } from "../companyService.js";
import { inventoryService } from "../inventoryService.js";
import archiver from "archiver";
import { ObjectId } from "mongodb";
import { driveService } from "../driveService.js";
import { excelService } from "../excelService.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from 'url';
import crypto from "crypto";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Main Express router instance.
const router = express.Router();

// Login brute-force protection: 5 attempts per 15 minutes.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes.
  max: 5, // Max attempts per window.
  message: {
    message: "Demasiados intentos de inicio de sesión. Intenta nuevamente en 15 minutos.",
    code: "TOO_MANY_REQUESTS"
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// Contact form throttling: 3 requests per hour.
const contactLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 3,
  message: {
    message: "Demasiados mensajes de contacto. Intenta nuevamente en 1 hora.",
    code: "TOO_MANY_REQUESTS"
  },
  standardHeaders: true,
  legacyHeaders: false,
});

const appAuthLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  message: {
    message: "Demasiados intentos de autenticación de app. Intenta en 1 minuto.",
    code: "TOO_MANY_REQUESTS",
  },
  standardHeaders: true,
  legacyHeaders: false,
});

const appRoutesLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  message: {
    message: "Demasiadas solicitudes de app. Intenta más tarde.",
    code: "TOO_MANY_REQUESTS",
  },
  standardHeaders: true,
  legacyHeaders: false,
});

const hashSecret = (secret) =>
  crypto.createHash("sha256").update(String(secret || "")).digest("hex");

const safeEqualSecret = (plainTextSecret, storedHash) => {
  const incoming = hashSecret(plainTextSecret);
  const a = Buffer.from(incoming, "utf8");
  const b = Buffer.from(String(storedHash || ""), "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
};

const appDevicesCollection = async () => {
  const db = await connect();
  const col = db.collection("app_devices");
  await col.createIndex({ deviceId: 1 }, { unique: true });
  return col;
};

// Shared upload middleware with MIME validation.
const upload = multer({
  dest: config.upload.dest,
  limits: { fileSize: config.upload.maxFileSize },
  fileFilter: (_req, file, cb) => {
    if (config.upload.allowedMimeTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`Tipo de archivo no permitido: ${file.mimetype}`), false);
    }
  },
});

// SSE stream for real-time notifications to USER accounts.
router.get(
  "/notifications/stream",
  authenticate,
  (req, res) => {
    // Restrict stream to end-user accounts.
    if (req.user.role !== "USER") {
      return res.status(403).json({ message: "Solo para clientes", code: "FORBIDDEN" });
    }

    // Configure SSE response headers.
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

    // Keep connection alive through periodic heartbeats.
    const heartbeat = setInterval(() => {
      try { res.write(": heartbeat\n\n"); } catch { /* ignore */ }
    }, 30_000);

    // Register client connection.
    const { username } = req.user;
    notificationService.addClient(username, res);

    // Remove client on disconnect.
    req.on("close", () => {
      clearInterval(heartbeat);
      notificationService.removeClient(username, res);
    });
  },
);

router.get(
  "/notifications/pending",
  userGuard,
  asyncHandler(async (req, res) => {
    const { username, empresa } = req.user;
    const pending = await notificationInboxService.getPendingForUser({
      username,
      empresa,
    });

    if (!pending.latestCertificate || pending.count === 0) {
      return res.json({ count: 0, notification: null });
    }

    const timestamp = pending.latestCertificate.createdAt
      ? new Date(pending.latestCertificate.createdAt).getTime()
      : Date.now();

    const notification = buildCertificateCreatedPayload(
      pending.latestCertificate,
      {
        source: "pending",
        pendingCount: pending.count,
        pendingNumbers: pending.pendingNumbers,
        timestamp,
      },
    );

    res.json({
      count: pending.count,
      seenAt: pending.seenAt?.toISOString?.() || null,
      notification,
    });
  }),
);

router.post(
  "/notifications/seen",
  userGuard,
  asyncHandler(async (req, res) => {
    const seenAt = await notificationInboxService.markSeen(req.user.username);
    res.json({ ok: true, seenAt: seenAt.toISOString() });
  }),
);

router.get("/health", healthMiddleware);
router.get(
  "/metrics",
  adminGuard,
  asyncHandler(async (req, res) => {
    const metrics = performanceMonitor.getMetrics();
    res.json(metrics);
  }),
);

router.post(
  "/contact",
  contactLimiter,
  asyncHandler(async (req, res) => {
    const result = await emailService.sendContactEmail(req.body);
    res.json(result);
  }),
);

router.get(
  "/auth/users",
  adminGuard,
  asyncHandler(async (req, res) => {
    const users = await userService.getAllUsers();
    res.json(users);
  }),
);

router.post(
  "/auth/login",
  loginLimiter,
  asyncHandler(async (req, res) => {
    const { username, password } = req.body;
    // Hard type-check credentials to reduce NoSQL injection vectors.
    if (typeof username !== "string" || typeof password !== "string") {
      return res.status(400).json({ message: "Credenciales inválidas", code: "BAD_REQUEST" });
    }
    const user = await userService.authenticateUser(username, password);
    
    // Issue session JWT.
    const token = jwt.sign(
      {
        username: user.username,
        role: user.role,
        empresa: user.empresa
      },
      config.jwt.secret,
      { expiresIn: config.jwt.expiresIn }
    );
    
    // Store token in HTTP-only cookie.
    res.cookie(config.jwt.cookie.name, token, {
      httpOnly: config.jwt.cookie.httpOnly,
      secure: config.jwt.cookie.secure,
      sameSite: config.jwt.cookie.sameSite,
      maxAge: config.jwt.cookie.maxAge
    });
    
    // Return user profile without exposing token in JSON body.
    res.json(user);
  }),
);

router.post(
  "/auth/logout",
  asyncHandler(async (req, res) => {
    // Clear session cookie.
    res.clearCookie(config.jwt.cookie.name);
    res.json({ message: "Sesión cerrada exitosamente" });
  }),
);

router.get(
  "/certificates",
  authenticate,
  asyncHandler(async (req, res) => {
    // Server-side authorization: filter certificates by user role/empresa/assignment
    const { role, username, empresa } = req.user;
    const certificates = await certificateService.getCertificatesForUser({
      role,
      username,
      empresa
    });
    res.json(certificates);
  }),
);

router.post(
  "/certificates/download",
  userGuard,
  asyncHandler(async (req, res) => {
    const { ids } = req.body || {};
    if (!Array.isArray(ids) || ids.length === 0) {
      return res
        .status(400)
        .json({ message: "ids requeridos", code: "BAD_REQUEST" });
    }

    const { username, empresa } = req.user;
    const kindPrefixMap = {
      informes: "INF",
      formatos: "FOR",
      certificados: "CER"
    };

    const kindPrefix = (kind) => kindPrefixMap[String(kind || "").toLowerCase()] || "DOC";

    const prefixedName = (kind, originalName) => {
      const p = kindPrefix(kind);
      const n = String(originalName || "").trim() || "archivo.pdf";
      return `${p}_${n}`;
    };

    
    const db = await connect();
    const validHex = /^[a-fA-F0-9]{24}$/;
    if (!ids.every((id) => typeof id === "string" && validHex.test(id))) {
      return res
        .status(400)
        .json({ message: "IDs inválidos", code: "BAD_REQUEST" });
    }
    const objIds = ids.map((id) => new ObjectId(id));
    const certs = await db
      .collection("certificates")
      .find({ _id: { $in: objIds } })
      .toArray();

    if (!certs.length) {
      return res
        .status(404)
        .json({ message: "No se encontraron certificados", code: "NOT_FOUND" });
    }

    
    const allowed = certs.filter((c) => {
      const sameEmpresa = String(c.empresa || "") === String(empresa);
      const au = Array.isArray(c.assignedUsers) ? c.assignedUsers : [];
      const hasUser = au.some((u) => String(u).trim() === String(username));
      return sameEmpresa && hasUser;
    });

    if (allowed.length !== certs.length) {
      return res.status(403).json({
        message: "Uno o más certificados no te pertenecen",
        code: "INSUFFICIENT_PERMISSIONS",
      });
    }

    
    const certPayloads = allowed.map((c) => {
      const links = c.links || {};
      const candidates = [
        { kind: "informes", link: links.informes },
        { kind: "formatos", link: links.formatos },
        { kind: "certificados", link: links.certificados },
      ];

      const files = candidates
        .map((x) => ({
          ...x,
          fileId: driveService.extractFileIdFromLink(x.link),
        }))
        .filter((x) => x.fileId);

      return {
        id: c._id.toString(),
        numCert: c.numCert,
        serial: c.serial,
        files,
      };
    });

    
    if (certPayloads.length === 1) {
      const one = certPayloads[0];

      
      if (one.files.length === 1) {
        const f = one.files[0];
        const { name, stream } = await driveService.downloadFileStream(f.fileId);

        res.setHeader("Content-Type", "application/octet-stream");
        res.setHeader("Content-Disposition", `attachment; filename="${name}"`);
        
        stream.on("error", (err) => {
          logger.error("Stream error in download", err);
          stream.destroy();
          if (!res.headersSent) {
            res.status(500).json({ message: "Error descargando archivo", code: "DOWNLOAD_ERROR" });
          }
        });
        res.on("close", () => stream.destroy());
        return stream.pipe(res);
      }

      
      const zipName = `${one.numCert} - ${one.serial}.zip`;

      res.setHeader("Content-Type", "application/zip");
      res.setHeader("Content-Disposition", `attachment; filename="${zipName}"`);

      const archive = archiver("zip", { zlib: { level: 9 } });
      archive.on("error", (err) => {
        throw err;
      });
      archive.pipe(res);

      for (const f of one.files) {
        const { name, stream } = await driveService.downloadFileStream(f.fileId);
        const outName = prefixedName(f.kind, name);
        archive.append(stream, { name: outName });
      }

      await archive.finalize();
      return;
    }

    
    const mainName = `Certificados ${empresa}.zip`;

    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="${mainName}"`);

    const main = archiver("zip", { zlib: { level: 9 } });
    main.on("error", (err) => {
      throw err;
    });
    main.pipe(res);

    
    const filePromises = certPayloads.map(async (c) => {
      if (c.files.length === 1) {
        const f = c.files[0];
        const { name, stream } = await driveService.downloadFileStream(f.fileId);
        const outName = prefixedName(f.kind, name);
        main.append(stream, { name: outName });
      } else {
        const innerZipName = `${c.numCert} - ${c.serial}.zip`;

        const inner = archiver("zip", { zlib: { level: 9 } });
        inner.on("error", (err) => {
          throw err;
        });

        main.append(inner, { name: innerZipName });

        for (const f of c.files) {
          const { name, stream } = await driveService.downloadFileStream(f.fileId);
          const outName = prefixedName(f.kind, name);
          inner.append(stream, { name: outName });
        }
        await inner.finalize();
      }
    });

    await Promise.all(filePromises);

    await main.finalize();
  }),
);

router.post(
  "/certificates",
  adminGuard,
  upload.fields([
    { name: "informes", maxCount: 1 },
    { name: "formatos", maxCount: 1 }, // Legacy field kept for older records.
    { name: "certificados", maxCount: 1 },
    { name: "anexos", maxCount: 1 },
  ]),
  asyncHandler(async (req, res) => {
    const certificate = await certificateService.createCertificate(
      req.body,
      req.files,
    );
    // Notify assigned users via SSE.
    notificationService.notifyCertificateCreated(certificate);
    res.status(201).json(certificate);
  }),
);

router.put(
  "/certificates/:id",
  adminGuard,
  upload.fields([
    { name: "informes", maxCount: 1 },
    { name: "formatos", maxCount: 1 }, // Legacy field kept for older records.
    { name: "certificados", maxCount: 1 },
    { name: "anexos", maxCount: 1 },
  ]),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const certificate = await certificateService.updateCertificate(
      id,
      req.body,
      req.files,
    );
    res.json(certificate);
  }),
);

router.delete(
  "/certificates/bulk",
  adminGuard,
  asyncHandler(async (req, res) => {
    const { items } = req.body;
    const result = await certificateService.deleteCertificates(items);
    res.json(result);
  }),
);


router.get(
  "/drafts",
  adminGuard,
  asyncHandler(async (req, res) => {
    const drafts = await draftService.getAllDrafts();
    res.json(drafts);
  }),
);

router.post(
  "/drafts",
  adminGuard,
  upload.fields([
    { name: "informes", maxCount: 1 },
    { name: "formatos", maxCount: 1 }, // Legacy field kept for older records.
    { name: "certificados", maxCount: 1 },
    { name: "anexos", maxCount: 1 },
  ]),
  asyncHandler(async (req, res) => {
    const draft = await draftService.createDraft(req.body, req.files || {});
    res.status(201).json(draft);
  }),
);

router.put(
  "/drafts/:id",
  adminGuard,
  upload.fields([
    { name: "informes", maxCount: 1 },
    { name: "formatos", maxCount: 1 }, // Legacy field kept for older records.
    { name: "certificados", maxCount: 1 },
    { name: "anexos", maxCount: 1 },
  ]),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const draft = await draftService.updateDraft(id, req.body, req.files || {});
    res.json(draft);
  }),
);

router.delete(
  "/drafts/bulk",
  adminGuard,
  asyncHandler(async (req, res) => {
    const { ids } = req.body;
    const result = await draftService.deleteDraftsByIds(ids);
    res.json(result);
  }),
);

router.post(
  "/drafts/:id/publish",
  adminGuard,
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const created = await draftService.publishDraft(id);
    // Notify assigned users via SSE.
    notificationService.notifyCertificateCreated(created);
    res.status(201).json(created);
  }),
);

// Mobile app endpoints used by the offline-first sync client.
// These routes use appGuard instead of role-based admin/user guards.

router.use("/app", appRoutesLimiter);

// Collection for tracking enrollment token usage
const enrollmentTokensCollection = async () => {
  const db = await connect();
  const col = db.collection("enrollment_tokens");
  await col.createIndex({ tokenId: 1 }, { unique: true });
  await col.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
  return col;
};

/**
 * Admin endpoint to generate enrollment tokens for device provisioning.
 * Each token can be used to register up to maxDevices devices.
 */
router.post(
  "/app/auth/enrollment-token",
  adminGuard,
  asyncHandler(async (req, res) => {
    const maxDevices = Math.min(
      parseInt(req.body?.maxDevices) || config.security.maxDevicesPerEnrollment,
      50 // Hard cap
    );
    const expiresIn = req.body?.expiresIn || config.security.enrollmentTokenExpiresIn;
    const label = String(req.body?.label || "").trim().slice(0, 100) || null;

    const tokenId = crypto.randomBytes(16).toString("hex");
    const token = jwt.sign(
      { tokenId, maxDevices, type: "enrollment" },
      config.security.enrollmentSecret,
      { expiresIn, issuer: "fares-backend" }
    );

    const decoded = jwt.decode(token);
    const expiresAt = decoded?.exp ? new Date(decoded.exp * 1000) : null;

    const tokens = await enrollmentTokensCollection();
    await tokens.insertOne({
      tokenId,
      label,
      maxDevices,
      usedDevices: 0,
      deviceIds: [],
      createdBy: req.user.username,
      createdAt: new Date(),
      expiresAt,
    });

    logger.info("Enrollment token created", {
      tokenId,
      maxDevices,
      createdBy: req.user.username,
      label,
    });

    res.status(201).json({
      token,
      tokenId,
      maxDevices,
      expiresAt: expiresAt?.toISOString() || null,
    });
  }),
);

/**
 * Admin endpoint to list and monitor enrollment tokens.
 */
router.get(
  "/app/auth/enrollment-tokens",
  adminGuard,
  asyncHandler(async (req, res) => {
    const tokens = await enrollmentTokensCollection();
    const list = await tokens
      .find({})
      .sort({ createdAt: -1 })
      .limit(100)
      .toArray();

    res.json(list.map(t => ({
      tokenId: t.tokenId,
      label: t.label,
      maxDevices: t.maxDevices,
      usedDevices: t.usedDevices,
      createdBy: t.createdBy,
      createdAt: t.createdAt,
      expiresAt: t.expiresAt,
    })));
  }),
);

/**
 * Admin endpoint to revoke an enrollment token.
 */
router.delete(
  "/app/auth/enrollment-token/:tokenId",
  adminGuard,
  asyncHandler(async (req, res) => {
    const { tokenId } = req.params;
    const tokens = await enrollmentTokensCollection();
    const result = await tokens.deleteOne({ tokenId });

    if (result.deletedCount === 0) {
      return res.status(404).json({
        message: "Token no encontrado",
        code: "NOT_FOUND",
      });
    }

    logger.info("Enrollment token revoked", {
      tokenId,
      revokedBy: req.user.username,
    });

    res.json({ ok: true });
  }),
);

router.post(
  "/app/auth/device-register",
  appAuthLimiter,
  asyncHandler(async (req, res) => {
    const deviceIdRaw = String(req.body?.deviceId || "").trim();
    const platformRaw = String(req.body?.platform || "unknown").trim().toLowerCase();
    const appVersionRaw = String(req.body?.appVersion || "").trim();
    const enrollmentToken = String(req.body?.enrollmentToken || "").trim();

    const deviceId = deviceIdRaw.slice(0, 128);
    const appVersion = appVersionRaw.slice(0, 32);
    const allowedPlatforms = new Set(["ios", "android", "web", "unknown"]);
    const platform = allowedPlatforms.has(platformRaw) ? platformRaw : "unknown";

    if (!deviceId || deviceId.length < 8) {
      return res.status(400).json({
        message: "deviceId inválido",
        code: "BAD_REQUEST",
      });
    }

    const devices = await appDevicesCollection();
    const existing = await devices.findOne({ deviceId });

    // Handle existing device re-registration
    if (existing) {
      if (existing.status === "revoked") {
        return res.status(403).json({
          message: "Dispositivo revocado",
          code: "DEVICE_REVOKED",
        });
      }

      // Re-registration requires proof of ownership via current secret
      const currentSecret = String(req.body?.currentSecret || "").trim();
      if (!currentSecret) {
        return res.status(401).json({
          message: "Se requiere el secreto actual para re-registrar el dispositivo",
          code: "CURRENT_SECRET_REQUIRED",
        });
      }

      if (!safeEqualSecret(currentSecret, existing.secretHash)) {
        logger.warn("Device re-registration failed: invalid current secret", { deviceId });
        return res.status(401).json({
          message: "Secreto actual inválido",
          code: "INVALID_CURRENT_SECRET",
        });
      }

      const rotatedSecret = crypto.randomBytes(32).toString("hex");
      await devices.updateOne(
        { deviceId },
        {
          $set: {
            secretHash: hashSecret(rotatedSecret),
            platform,
            appVersion,
            lastSeenAt: new Date(),
          },
        },
      );

      return res.json({
        ok: true,
        alreadyRegistered: true,
        deviceSecret: rotatedSecret,
      });
    }

    // New device registration requires enrollment token (unless disabled)
    if (config.security.requireEnrollmentToken) {
      if (!enrollmentToken) {
        return res.status(401).json({
          message: "Token de provisión requerido para nuevos dispositivos",
          code: "ENROLLMENT_TOKEN_REQUIRED",
        });
      }

      // Validate enrollment token
      let tokenPayload;
      try {
        tokenPayload = jwt.verify(enrollmentToken, config.security.enrollmentSecret, {
          issuer: "fares-backend",
        });
        if (tokenPayload.type !== "enrollment") {
          throw new Error("Invalid token type");
        }
      } catch (err) {
        logger.warn("Invalid enrollment token", { error: err.message, deviceId });
        return res.status(401).json({
          message: "Token de provisión inválido o expirado",
          code: "INVALID_ENROLLMENT_TOKEN",
        });
      }

      // Atomically check and increment token usage to prevent race conditions
      const tokens = await enrollmentTokensCollection();
      const updateResult = await tokens.findOneAndUpdate(
        {
          tokenId: tokenPayload.tokenId,
          $expr: { $lt: ["$usedDevices", "$maxDevices"] },
        },
        {
          $inc: { usedDevices: 1 },
          $push: { deviceIds: deviceId },
        },
        { returnDocument: "before" },
      );

      if (!updateResult) {
        // Check if token exists but exhausted, or doesn't exist
        const existingToken = await tokens.findOne({ tokenId: tokenPayload.tokenId });
        if (!existingToken) {
          return res.status(401).json({
            message: "Token de provisión no encontrado o revocado",
            code: "ENROLLMENT_TOKEN_REVOKED",
          });
        }
        logger.warn("Enrollment token exhausted", {
          tokenId: tokenPayload.tokenId,
          usedDevices: existingToken.usedDevices,
          maxDevices: existingToken.maxDevices,
        });
        return res.status(403).json({
          message: "Token de provisión ha alcanzado el límite de dispositivos",
          code: "ENROLLMENT_TOKEN_EXHAUSTED",
        });
      }

      logger.info("Device enrolled with token", {
        deviceId,
        tokenId: tokenPayload.tokenId,
        platform,
      });

      // Insert device with rollback on failure to prevent token exhaustion attacks
      const deviceSecret = crypto.randomBytes(32).toString("hex");
      try {
        await devices.insertOne({
          deviceId,
          secretHash: hashSecret(deviceSecret),
          status: "active",
          platform,
          appVersion,
          createdAt: new Date(),
          lastSeenAt: new Date(),
        });
      } catch (insertError) {
        // Rollback token usage on device insert failure
        await tokens.updateOne(
          { tokenId: tokenPayload.tokenId },
          {
            $inc: { usedDevices: -1 },
            $pull: { deviceIds: deviceId },
          },
        );
        logger.error("Device insert failed, rolled back token usage", {
          deviceId,
          tokenId: tokenPayload.tokenId,
          error: insertError.message,
        });
        throw insertError;
      }

      return res.status(201).json({
        ok: true,
        alreadyRegistered: false,
        deviceSecret,
      });
    }

    // New device without enrollment token requirement (legacy flow or disabled)
    const deviceSecret = crypto.randomBytes(32).toString("hex");
    await devices.insertOne({
      deviceId,
      secretHash: hashSecret(deviceSecret),
      status: "active",
      platform,
      appVersion,
      createdAt: new Date(),
      lastSeenAt: new Date(),
    });

    res.status(201).json({
      ok: true,
      alreadyRegistered: false,
      deviceSecret,
    });
  }),
);

router.post(
  "/app/auth/token",
  appAuthLimiter,
  asyncHandler(async (req, res) => {
    const deviceIdRaw = String(req.body?.deviceId || "").trim();
    const platformRaw = String(req.body?.platform || "unknown").trim().toLowerCase();
    const appVersionRaw = String(req.body?.appVersion || "").trim();
    const deviceSecret = String(req.body?.deviceSecret || "").trim();

    const deviceId = deviceIdRaw.slice(0, 128);
    const appVersion = appVersionRaw.slice(0, 32);
    const allowedPlatforms = new Set(["ios", "android", "web", "unknown"]);
    const platform = allowedPlatforms.has(platformRaw) ? platformRaw : "unknown";

    if (!deviceId || deviceId.length < 8) {
      return res.status(400).json({
        message: "deviceId inválido",
        code: "BAD_REQUEST",
      });
    }

    if (!deviceSecret) {
      return res.status(401).json({
        message: "Credenciales de dispositivo requeridas",
        code: "DEVICE_SECRET_REQUIRED",
      });
    }

    const devices = await appDevicesCollection();
    const device = await devices.findOne({ deviceId });

    if (!device) {
      return res.status(401).json({
        message: "Dispositivo no registrado",
        code: "DEVICE_NOT_ENROLLED",
      });
    }

    if (device.status === "revoked") {
      return res.status(403).json({
        message: "Dispositivo revocado",
        code: "DEVICE_REVOKED",
      });
    }

    if (!safeEqualSecret(deviceSecret, device.secretHash)) {
      return res.status(401).json({
        message: "Credenciales de dispositivo inválidas",
        code: "INVALID_DEVICE_SECRET",
      });
    }

    await devices.updateOne(
      { deviceId },
      {
        $set: {
          platform,
          appVersion,
          lastSeenAt: new Date(),
        },
      },
    );

    const token = jwt.sign(
      {
        deviceId,
        platform,
        appVersion,
      },
      config.security.appJwtSecret,
      {
        expiresIn: config.security.appJwtExpiresIn,
        audience: "fares-mobile-app",
        issuer: "fares-backend",
      },
    );

    const decoded = jwt.decode(token);
    const expiresAt = decoded?.exp
      ? new Date(decoded.exp * 1000).toISOString()
      : null;

    res.json({ token, expiresAt });
  }),
);

router.post(
  "/app/drafts",
  appGuard,
  upload.any(),
  asyncHandler(async (req, res) => {
    const startedAt = Date.now();
    // Mobile app sends the full inspection payload.
    const { inspeccionCompleta, ...draftData } = req.body;

    if (!inspeccionCompleta) {
      return res.status(400).json({
        message: "inspeccionCompleta es requerido",
        code: "MISSING_INSPECTION_DATA"
      });
    }

    // Validate required draft identity fields.
    if (!draftData.serial || !draftData.empresa) {
      return res.status(400).json({
        message: "serial y empresa son requeridos",
        code: "MISSING_REQUIRED_FIELDS"
      });
    }

    const photoFiles = (req.files || []).filter((file) =>
      String(file.fieldname || "").startsWith("photo_")
    );

    logger.info("App draft sync started", {
      serial: draftData.serial,
      empresa: draftData.empresa,
      photosUploaded: photoFiles.length,
    });

    // Multipart requests may send JSON as a string.
    let inspectionData;
    try {
      inspectionData = typeof inspeccionCompleta === 'string' 
        ? JSON.parse(inspeccionCompleta) 
        : inspeccionCompleta;
    } catch (err) {
      return res.status(400).json({
        message: "inspeccionCompleta tiene formato inválido",
        code: "INVALID_JSON_FORMAT"
      });
    }

    if (Array.isArray(inspectionData?.fotos) && photoFiles.length > 0) {
      const filesByField = new Map(photoFiles.map((file) => [file.fieldname, file]));
      inspectionData.fotos = inspectionData.fotos.map((photo) => {
        if (!photo?.uploadField) return photo;
        const uploaded = filesByField.get(photo.uploadField);
        if (!uploaded) return photo;
        return {
          ...photo,
          uploadedPath: uploaded.path,
          uploadedMimeType: uploaded.mimetype,
        };
      });
    }

    try {
      const info = inspectionData?.informacionItem || {};
      const hasLocation =
        (info?.nombreUbicacion && String(info.nombreUbicacion).trim()) ||
        (info?.direccion && String(info.direccion).trim());

      if (hasLocation) {
        await inventoryService.createSite({
          name: info?.nombreUbicacion,
          address: info?.direccion,
          latitud: info?.latitud,
          longitud: info?.longitud,
          source: 'inspection',
        });
      }
    } catch (error) {
      logger.warn('Inventory site creation failed', { error: error.message });
    }

    // Feature flag for automatic PDF generation from the workbook.
    // Keep disabled until the mobile payload fully covers validated inputs.
    const ENABLE_AUTO_PDF = false;

    // 1) Fill Excel template.
    logger.info("Step 1: Filling Excel template", { serial: draftData.serial });
    const workbook = await excelService.fillTemplate(inspectionData);
    logger.info("Step 1 complete: Excel template filled");

    // 2) Prepare temporary files.
    const tempDir = path.join(__dirname, '..', 'uploads');
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

    const timestamp = Date.now();
    const excelPath = path.join(tempDir, `inspection_${timestamp}.xlsx`);
    const pdfSourceExcelPath = path.join(tempDir, `inspection_pdf_source_${timestamp}.xlsx`);
    const pdfPath = path.join(tempDir, `inspection_${timestamp}.pdf`);

    const serialForName = draftData.serial || 'INSPECCION';
    const empresaForName = draftData.empresa || 'DRAFT';
    const numCertForName = draftData.numCert || 'DRAFT';
    const excelFileName = `${empresaForName}_${numCertForName}_${serialForName}_${timestamp}.xlsx`;

    let draft;
    try {
      logger.info("Step 2: Saving main Excel workbook");
      await excelService.saveWorkbook(workbook, excelPath);
      logger.info("Step 2 complete: Excel saved", { excelPath });

      // Optional PDF path, intentionally disabled for current operations.
      if (ENABLE_AUTO_PDF) {
        logger.info("Step 3: Cloning workbook for PDF");
        const pdfWorkbook = await excelService.cloneWorkbook(workbook);
        // Exclude categories that should not appear in the PDF report.
        excelService.insertPhotoRecords(pdfWorkbook, inspectionData.fotos || [], {
          excludeCategories: ['revision_interna', 'prueba_hidrostatica', 'medicion_espesores', 'proteccion_catodica'],
        });
        excelService.prepareWorkbookForPdf(pdfWorkbook, [
          'Prueba Hidrostática',
          'SOPORTE',
        ]);
        await excelService.saveWorkbook(pdfWorkbook, pdfSourceExcelPath);
        logger.info("Step 3 complete: PDF source ready", { pdfSourceExcelPath });

        logger.info("Step 4: Converting Excel to PDF via Google Sheets");
        await driveService.convertExcelToPdf(pdfSourceExcelPath, pdfPath);
        logger.info("Step 4 complete: PDF generated", { pdfPath });
      }

      // 3) Upload Excel and reuse its URL in `links.formatos`.
      logger.info("Step 3: Uploading Excel to Drive");
      const dbFolders = await driveService.getDriveFolders();
      const informesFolder =
        dbFolders.INF ||
        config.google.drive.folders.INF ||
        config.google.drive.parentFolderId;

      const excelUploadResult = await driveService.uploadFile({
        localPath: excelPath,
        fileName: excelFileName,
        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        appProperties: {
          Usuario: String(draftData.assignedUsers || ''),
          NumCert: String(numCertForName),
          Serial: String(serialForName),
        },
        folderId: informesFolder,
      });

      logger.info("Step 3 complete: Excel uploaded to Drive", {
        folder: "INF",
        fileName: excelFileName,
        link: excelUploadResult?.webViewLink,
      });

      // 4) Create draft with generated document links.
      logger.info("Step 4: Creating draft");
      const files = {};

      if (ENABLE_AUTO_PDF) {
        files.informes = [{
          path: pdfPath,
          originalname: `${serialForName}_${timestamp}.pdf`,
          mimetype: 'application/pdf'
        }];
      }

      // Persist uploaded Excel URL as legacy `formatos` link.
      draftData.links = {
        ...(draftData.links || {}),
        formatos: excelUploadResult?.webViewLink || '#',
      };

      draft = await draftService.createDraft(draftData, files);
      logger.info("Step 4 complete: Draft created", { draftId: draft?.id });
      logger.info("App draft sync completed", {
        draftId: draft?.id,
        elapsedMs: Date.now() - startedAt,
      });

      res.status(201).json(draft);
    } finally {
      // Always clean up temporary files.
      try {
        fs.unlinkSync(excelPath);
      } catch (_err) {
        // Best-effort cleanup.
      }

      if (ENABLE_AUTO_PDF) {
        try {
          fs.unlinkSync(pdfSourceExcelPath);
        } catch (_err) {
          // Best-effort cleanup.
        }

        try {
          fs.unlinkSync(pdfPath);
        } catch (_err) {
          // Best-effort cleanup.
        }
      }

      for (const photoFile of photoFiles) {
        try {
          fs.unlinkSync(photoFile.path);
        } catch (_err) {
          // Best-effort cleanup.
        }
      }
    }
  }),
);

router.get(
  "/app/health",
  asyncHandler(async (req, res) => {
    // Lightweight mobile connectivity check.
    res.json({ 
      status: "ok", 
      timestamp: new Date().toISOString(),
      version: "1.0.0"
    });
  }),
);

router.get(
  "/app/companies",
  appGuard,
  asyncHandler(async (_req, res) => {
    const companies = await companyService.getAllCompanies();
    res.json(companies);
  }),
);

router.get(
  "/app/sites",
  appGuard,
  asyncHandler(async (_req, res) => {
    const sites = await inventoryService.getSites();
    res.json(sites);
  }),
);

router.post(
  "/app/sites",
  appGuard,
  asyncHandler(async (req, res) => {
    const site = await inventoryService.createSite(req.body || {});
    res.status(201).json(site);
  }),
);

router.get(
  "/admin/drive-folders",
  adminGuard,
  asyncHandler(async (req, res) => {
    const folders = await configService.getDriveFolders();
    res.json(folders);
  }),
);

router.put(
  "/admin/drive-folders",
  adminGuard,
  asyncHandler(async (req, res) => {
    const folders = await configService.updateDriveFolders(req.body);
    res.json(folders);
  }),
);

router.get(
  "/drive/fileinfo",
  adminGuard,
  asyncHandler(async (req, res) => {
    const { id } = req.query;
    const fileInfo = await configService.getDriveFileInfo(id);
    res.json(fileInfo);
  }),
);

router.get(
  "/admin/companies",
  adminGuard,
  asyncHandler(async (_req, res) => {
    const companies = await companyService.getAllCompanies();
    res.json(companies);
  }),
);

router.post(
  "/admin/companies",
  adminGuard,
  asyncHandler(async (req, res) => {
    const { name } = req.body || {};
    const company = await companyService.createCompany(name);
    res.status(201).json(company);
  }),
);


router.put(
  "/admin/users/password",
  adminGuard,
  asyncHandler(async (req, res) => {
    const { username, newPassword } = req.body;
    const result = await userService.adminUpdateUserPassword(
      username,
      newPassword,
    );
    res.json(result);
  }),
);

router.post(
  "/admin/users",
  adminGuard,
  asyncHandler(async (req, res) => {
    const user = await userService.createUser(req.body || {});
    res.status(201).json(user);
  }),
);

router.delete(
  "/admin/users/:username",
  adminGuard,
  asyncHandler(async (req, res) => {
    const { username } = req.params;
    const result = await userService.deleteUser(username);
    res.json(result);
  }),
);

router.put(
  "/admin/users/:username/password",
  adminGuard,
  asyncHandler(async (req, res) => {
    const { username } = req.params;
    const { newPassword } = req.body;
    const result = await userService.updateUserPassword(username, newPassword);
    res.json(result);
  }),
);


export default router;
