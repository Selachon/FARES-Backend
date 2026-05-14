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
import { pdfService } from "../pdfService.js";
import { certDocService } from "../certDocService.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from 'url';
import crypto from "crypto";
import ExcelJS from "exceljs";

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

const normalizeInspectorName = (value) =>
  String(value || "")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 120);

const normalizePlaceKey = (value) =>
  String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");

const formatPlaceName = (value) =>
  String(value || "")
    .trim()
    .replace(/\s+/g, " ")
    .replace(/\s+D\s*\.?\s*C\s*\.?$/i, " D.C.")
    .toLocaleUpperCase("es-CO");

const parseCoordinate = (value) => {
  if (value === null || value === undefined || value === "") return NaN;
  return Number(value);
};

const COLOMBIA_DEPARTMENT_KEYS = new Set([
  "AMAZONAS",
  "ANTIOQUIA",
  "ARAUCA",
  "ATLANTICO",
  "BOGOTA",
  "BOGOTA D C",
  "BOLIVAR",
  "BOYACA",
  "CALDAS",
  "CAQUETA",
  "CASANARE",
  "CAUCA",
  "CESAR",
  "CHOCO",
  "CORDOBA",
  "CUNDINAMARCA",
  "D C",
  "GUAINIA",
  "GUAVIARE",
  "HUILA",
  "LA GUAJIRA",
  "MAGDALENA",
  "META",
  "NARINO",
  "NORTE DE SANTANDER",
  "PUTUMAYO",
  "QUINDIO",
  "RISARALDA",
  "SAN ANDRES",
  "SANTANDER",
  "SUCRE",
  "TOLIMA",
  "VALLE DEL CAUCA",
  "VAUPES",
  "VICHADA",
]);

const SITE_PLACE_HINTS = [
  { pattern: /\bCOLSERGAS\b/, place: "FUNZA" },
  { pattern: /\bCAZUCA\b/, place: "SOACHA" },
  { pattern: /\bCHILCO\s+MADRID\b|\bMADRID\b/, place: "MADRID" },
  { pattern: /\bCHILCOMET\b|\bCHILCOMED\b/, place: "IBAGUÉ" },
  { pattern: /\bCOPACABANA\b/, place: "COPACABANA" },
  { pattern: /\bFOMEQUE\b/, place: "FÓMEQUE" },
  { pattern: /\bCHOACHI\b/, place: "CHOACHÍ" },
];

const isUsefulAddressPart = (value) => {
  const key = normalizePlaceKey(value);
  if (!key) return false;
  if (/^\d+$/.test(key)) return false;
  if (/^[A-Z0-9]{4,}\s?[+]\s?[A-Z0-9]{2,}$/.test(String(value || "").trim().toUpperCase())) return false;
  if (key === "COLOMBIA") return false;
  if (key === "UNNAMED ROAD") return false;
  return true;
};

const isLikelyPlaceCandidate = (value) => {
  if (!isUsefulAddressPart(value)) return false;
  const key = normalizePlaceKey(value);
  if (/^(AV|AVENIDA|CALLE|CL|CARRERA|CRA|DIAGONAL|DG|KM|KILOMETRO|LOCAL|TRANSVERSAL|TV|VIA)\b/.test(key)) {
    return false;
  }
  if (String(value || "").includes("#")) return false;
  return true;
};

const extractPlaceFromAddress = (address) => {
  const parts = String(address || "")
    .split(",")
    .map((part) => part.trim())
    .filter(isUsefulAddressPart);

  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const key = normalizePlaceKey(parts[index]);
    if (!COLOMBIA_DEPARTMENT_KEYS.has(key)) continue;

    const previous = parts[index - 1];
    if (!isLikelyPlaceCandidate(previous)) continue;

    const previousKey = normalizePlaceKey(previous);
    if (key === "D C" && previousKey === "BOGOTA") {
      return "BOGOTÁ D.C.";
    }
    return formatPlaceName(previous);
  }

  return "";
};

const extractPlaceFromSiteName = (name) => {
  const key = normalizePlaceKey(name);
  const hint = SITE_PLACE_HINTS.find((item) => item.pattern.test(key));
  return hint?.place || "";
};

const findNearestSite = (sites, latitud, longitud) => {
  const lat = parseCoordinate(latitud);
  const lng = parseCoordinate(longitud);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

  let nearest = null;
  let nearestDistance = Infinity;
  for (const site of sites) {
    const siteLat = parseCoordinate(site?.latitud);
    const siteLng = parseCoordinate(site?.longitud);
    if (!Number.isFinite(siteLat) || !Number.isFinite(siteLng)) continue;

    const distance = Math.hypot(lat - siteLat, lng - siteLng);
    if (distance < nearestDistance) {
      nearest = site;
      nearestDistance = distance;
    }
  }

  return nearestDistance <= 0.003 ? nearest : null;
};

const reverseGeocodePlace = async (info, cache) => {
  const lat = parseCoordinate(info?.latitud);
  const lng = parseCoordinate(info?.longitud);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return "";

  const key = `${lat.toFixed(5)},${lng.toFixed(5)}`;
  if (cache.has(key)) return cache.get(key);

  try {
    const params = new URLSearchParams({
      format: "jsonv2",
      lat: String(lat),
      lon: String(lng),
      "accept-language": "es",
    });
    const response = await fetch(`https://nominatim.openstreetmap.org/reverse?${params.toString()}`, {
      headers: { "User-Agent": "FARES-report-generator/1.0" },
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      cache.set(key, "");
      return "";
    }

    const data = await response.json();
    const address = data?.address || {};
    const place = formatPlaceName(
      address.city ||
      address.town ||
      address.municipality ||
      address.village ||
      address.county ||
      "",
    );
    cache.set(key, place);
    return place;
  } catch (error) {
    logger.warn("No se pudo resolver municipio por coordenadas", { error: error.message, lat, lng });
    cache.set(key, "");
    return "";
  }
};

const resolveInspectionPlace = ({ info, client, sites, siteByName }) => {
  const explicitPlace = formatPlaceName(info?.ciudad || info?.municipio || info?.departamento || "");
  if (explicitPlace) return explicitPlace;

  const siteName = info?.nombreUbicacion || "";
  const site = siteByName.get(normalizePlaceKey(siteName));
  const siteAddressPlace = extractPlaceFromAddress(site?.address);
  if (siteAddressPlace) return siteAddressPlace;

  const nearestSite = findNearestSite(sites, info?.latitud, info?.longitud);
  const nearestAddressPlace = extractPlaceFromAddress(nearestSite?.address);
  if (nearestAddressPlace) return nearestAddressPlace;

  const siteNamePlace = extractPlaceFromSiteName(siteName) || extractPlaceFromSiteName(site?.name) || extractPlaceFromSiteName(nearestSite?.name);
  if (siteNamePlace) return siteNamePlace;

  const addressPlace = extractPlaceFromAddress(info?.direccion);
  if (addressPlace) return addressPlace;

  const hasInspectionLocation = Boolean(
    String(siteName || "").trim() ||
    String(info?.direccion || "").trim() ||
    Number.isFinite(parseCoordinate(info?.latitud)) ||
    Number.isFinite(parseCoordinate(info?.longitud)),
  );

  return hasInspectionLocation
    ? ""
    : formatPlaceName(client?.ciudad || client?.municipio || client?.departamento || "");
};

const canGenerateReports = (user) => String(user?.role || "").toUpperCase() === "ADMIN";

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

      const archive = archiver("zip", { zlib: { level: 1 } });
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

    const main = archiver("zip", { zlib: { level: 1 } });
    main.on("error", (err) => {
      throw err;
    });
    main.pipe(res);

    
    for (const c of certPayloads) {
      if (c.files.length === 1) {
        const f = c.files[0];
        const { name, stream } = await driveService.downloadFileStream(f.fileId);
        const outName = prefixedName(f.kind, name);
        main.append(stream, { name: outName });
      } else {
        const innerZipName = `${c.numCert} - ${c.serial}.zip`;

        const inner = archiver("zip", { zlib: { level: 1 } });
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
    }

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
    const createdBy = String(req.user?.username || "").trim();
    const payload = {
      ...req.body,
      ...(createdBy ? { createdBy } : {}),
    };

    const certificate = await certificateService.createCertificate(
      payload,
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

// ==================== INSPECTION DETAIL ENDPOINTS ====================
// Endpoints para obtener/actualizar inspección completa (fotos incluidas)

/**
 * Obtener detalle completo de un borrador (incluyendo inspeccionCompleta y fotos)
 */
router.get(
  "/drafts/:id/detail",
  adminGuard,
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const draft = await draftService.getDraftById(id);
    res.json(draft);
  }),
);

/**
 * Obtener detalle completo de un certificado (incluyendo inspeccionCompleta y fotos)
 */
router.get(
  "/certificates/:id/detail",
  authenticate,
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { role, username, empresa } = req.user;
    
    const certificate = await certificateService.getCertificateById(id);
    
    // Verificar permisos: ADMIN ve todo, USER solo sus certificados asignados
    if (role !== "ADMIN" && role !== "SUPERVISOR") {
      const isAssigned = certificate.assignedUsers?.includes(username);
      const sameEmpresa = certificate.empresa === empresa;
      if (!isAssigned || !sameEmpresa) {
        return res.status(403).json({
          message: "No tienes acceso a este certificado",
          code: "INSUFFICIENT_PERMISSIONS",
        });
      }
    }
    
    res.json(certificate);
  }),
);

/**
 * Actualizar inspección completa de un borrador
 */
router.put(
  "/drafts/:id/inspection",
  adminGuard,
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { inspeccionCompleta, fotos, ...recordUpdates } = req.body;
    const hasFechaCargue = !!recordUpdates?.fechaCargue;
    const fechaCargueDate = hasFechaCargue ? new Date(recordUpdates.fechaCargue) : null;
    const fechaExpedicion = hasFechaCargue && !Number.isNaN(fechaCargueDate.getTime())
      ? fechaCargueDate.toISOString().slice(0, 10)
      : inspeccionCompleta?.datosInforme?.fechaExpedicion || null;
    const normalizedInspection = inspeccionCompleta
      ? {
          ...inspeccionCompleta,
          datosInforme: {
            ...(inspeccionCompleta.datosInforme || {}),
            ...(fechaExpedicion ? { fechaExpedicion } : {}),
          },
        }
      : inspeccionCompleta;
    
    const draft = await draftService.updateDraft(id, {
      ...recordUpdates,
      inspeccionCompleta: normalizedInspection,
      fotos,
    }, {});
    
    res.json(draft);
  }),
);

/**
 * Actualizar inspección completa de un certificado
 */
router.put(
  "/certificates/:id/inspection",
  adminGuard,
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { inspeccionCompleta, fotos, ...recordUpdates } = req.body;
    const hasFechaCargue = !!recordUpdates?.fechaCargue;
    const fechaCargueDate = hasFechaCargue ? new Date(recordUpdates.fechaCargue) : null;
    const fechaExpedicion = hasFechaCargue && !Number.isNaN(fechaCargueDate.getTime())
      ? fechaCargueDate.toISOString().slice(0, 10)
      : inspeccionCompleta?.datosInforme?.fechaExpedicion || null;
    const normalizedInspection = inspeccionCompleta
      ? {
          ...inspeccionCompleta,
          datosInforme: {
            ...(inspeccionCompleta.datosInforme || {}),
            ...(fechaExpedicion ? { fechaExpedicion } : {}),
          },
        }
      : inspeccionCompleta;
    
    const certificate = await certificateService.updateCertificate(id, {
      ...recordUpdates,
      inspeccionCompleta: normalizedInspection,
      fotos,
    }, {});
    
    res.json(certificate);
  }),
);

// ==================== PHOTO MANAGEMENT ENDPOINTS ====================

/**
 * Agregar foto a un borrador
 */
router.post(
  "/drafts/:id/photos",
  adminGuard,
  upload.single("photo"),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { category, description, includeInPdf } = req.body;
    const file = req.file;

    if (!file) {
      return res.status(400).json({
        message: "Se requiere una foto",
        code: "MISSING_PHOTO",
      });
    }

    const draft = await draftService.getDraftById(id);
    const existingPhotos = draft.fotos || [];

    // Subir foto a Drive
    let photoData = {
      id: `photo_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      category: category || 'superficie',
      description: description || '',
      timestamp: new Date().toISOString(),
      includeInPdf: includeInPdf !== 'false',
      driveFileId: null,
      driveUrl: null,
    };

    try {
      const dbFolders = await driveService.getDriveFolders();
      const photoFileName = `FOTO_${draft.serial || 'DRAFT'}_${category || 'foto'}_${Date.now()}.jpg`;
      
      const uploadResult = await driveService.uploadFile({
        localPath: file.path,
        fileName: photoFileName,
        mimeType: file.mimetype || 'image/jpeg',
        appProperties: {
          NumCert: String(draft.numCert || 'DRAFT'),
          Serial: String(draft.serial || 'DRAFT'),
          Category: category || 'general',
        },
        folderId: dbFolders.INF || config.google.drive.parentFolderId,
      });

      photoData.driveFileId = uploadResult?.id || null;
      photoData.driveUrl = uploadResult?.webViewLink || null;
      photoData.thumbnailUrl =
        driveService.getThumbnailUrl(photoData.driveFileId) ||
        uploadResult?.thumbnailLink ||
        null;
    } catch (uploadErr) {
      logger.warn("Failed to upload photo to Drive", { error: uploadErr.message });
    } finally {
      // Limpiar archivo temporal
      try { fs.unlinkSync(file.path); } catch (_) {}
    }

    // Agregar foto al array existente
    const updatedPhotos = [...existingPhotos, photoData];
    
    await draftService.updateDraft(id, { fotos: updatedPhotos }, {});
    
    res.status(201).json(photoData);
  }),
);

/**
 * Eliminar foto de un borrador
 */
router.delete(
  "/drafts/:id/photos/:photoId",
  adminGuard,
  asyncHandler(async (req, res) => {
    const { id, photoId } = req.params;
    
    const draft = await draftService.getDraftById(id);
    const existingPhotos = draft.fotos || [];
    
    const photoToDelete = existingPhotos.find(p => p.id === photoId);
    if (!photoToDelete) {
      return res.status(404).json({
        message: "Foto no encontrada",
        code: "PHOTO_NOT_FOUND",
      });
    }

    // Intentar eliminar de Drive si existe
    if (photoToDelete.driveFileId) {
      try {
        await driveService.deleteFile(photoToDelete.driveFileId);
      } catch (deleteErr) {
        logger.warn("Failed to delete photo from Drive", { 
          fileId: photoToDelete.driveFileId, 
          error: deleteErr.message 
        });
      }
    }

    // Actualizar array de fotos
    const updatedPhotos = existingPhotos.filter(p => p.id !== photoId);
    await draftService.updateDraft(id, { fotos: updatedPhotos }, {});
    
    res.json({ ok: true, deleted: photoId });
  }),
);

/**
 * Actualizar metadata de una foto (descripción, includeInPdf)
 */
router.put(
  "/drafts/:id/photos/:photoId",
  adminGuard,
  asyncHandler(async (req, res) => {
    const { id, photoId } = req.params;
    const { description, includeInPdf } = req.body;
    
    const draft = await draftService.getDraftById(id);
    const existingPhotos = draft.fotos || [];
    
    const photoIndex = existingPhotos.findIndex(p => p.id === photoId);
    if (photoIndex === -1) {
      return res.status(404).json({
        message: "Foto no encontrada",
        code: "PHOTO_NOT_FOUND",
      });
    }

    // Actualizar metadata
    const updatedPhoto = {
      ...existingPhotos[photoIndex],
      ...(description !== undefined && { description }),
      ...(includeInPdf !== undefined && { includeInPdf: includeInPdf !== false && includeInPdf !== 'false' }),
    };

    const updatedPhotos = [...existingPhotos];
    updatedPhotos[photoIndex] = updatedPhoto;
    
    await draftService.updateDraft(id, { fotos: updatedPhotos }, {});
    
    res.json(updatedPhoto);
  }),
);

// Endpoints similares para certificados
router.post(
  "/certificates/:id/photos",
  adminGuard,
  upload.single("photo"),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { category, description, includeInPdf } = req.body;
    const file = req.file;

    if (!file) {
      return res.status(400).json({
        message: "Se requiere una foto",
        code: "MISSING_PHOTO",
      });
    }

    const certificate = await certificateService.getCertificateById(id);
    const existingPhotos = certificate.fotos || [];

    let photoData = {
      id: `photo_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      category: category || 'superficie',
      description: description || '',
      timestamp: new Date().toISOString(),
      includeInPdf: includeInPdf !== 'false',
      driveFileId: null,
      driveUrl: null,
    };

    try {
      const dbFolders = await driveService.getDriveFolders();
      const photoFileName = `FOTO_${certificate.serial || 'CERT'}_${category || 'foto'}_${Date.now()}.jpg`;
      
      const uploadResult = await driveService.uploadFile({
        localPath: file.path,
        fileName: photoFileName,
        mimeType: file.mimetype || 'image/jpeg',
        appProperties: {
          NumCert: String(certificate.numCert || 'CERT'),
          Serial: String(certificate.serial || 'CERT'),
          Category: category || 'general',
        },
        folderId: dbFolders.INF || config.google.drive.parentFolderId,
      });

      photoData.driveFileId = uploadResult?.id || null;
      photoData.driveUrl = uploadResult?.webViewLink || null;
      photoData.thumbnailUrl =
        driveService.getThumbnailUrl(photoData.driveFileId) ||
        uploadResult?.thumbnailLink ||
        null;
    } catch (uploadErr) {
      logger.warn("Failed to upload photo to Drive", { error: uploadErr.message });
    } finally {
      try { fs.unlinkSync(file.path); } catch (_) {}
    }

    const updatedPhotos = [...existingPhotos, photoData];
    await certificateService.updateCertificate(id, { fotos: updatedPhotos }, {});
    
    res.status(201).json(photoData);
  }),
);

router.delete(
  "/certificates/:id/photos/:photoId",
  adminGuard,
  asyncHandler(async (req, res) => {
    const { id, photoId } = req.params;
    
    const certificate = await certificateService.getCertificateById(id);
    const existingPhotos = certificate.fotos || [];
    
    const photoToDelete = existingPhotos.find(p => p.id === photoId);
    if (!photoToDelete) {
      return res.status(404).json({
        message: "Foto no encontrada",
        code: "PHOTO_NOT_FOUND",
      });
    }

    if (photoToDelete.driveFileId) {
      try {
        await driveService.deleteFile(photoToDelete.driveFileId);
      } catch (deleteErr) {
        logger.warn("Failed to delete photo from Drive", { 
          fileId: photoToDelete.driveFileId, 
          error: deleteErr.message 
        });
      }
    }

    const updatedPhotos = existingPhotos.filter(p => p.id !== photoId);
    await certificateService.updateCertificate(id, { fotos: updatedPhotos }, {});
    
    res.json({ ok: true, deleted: photoId });
  }),
);

router.put(
  "/certificates/:id/photos/:photoId",
  adminGuard,
  asyncHandler(async (req, res) => {
    const { id, photoId } = req.params;
    const { description, includeInPdf } = req.body;
    
    const certificate = await certificateService.getCertificateById(id);
    const existingPhotos = certificate.fotos || [];
    
    const photoIndex = existingPhotos.findIndex(p => p.id === photoId);
    if (photoIndex === -1) {
      return res.status(404).json({
        message: "Foto no encontrada",
        code: "PHOTO_NOT_FOUND",
      });
    }

    const updatedPhoto = {
      ...existingPhotos[photoIndex],
      ...(description !== undefined && { description }),
      ...(includeInPdf !== undefined && { includeInPdf: includeInPdf !== false && includeInPdf !== 'false' }),
    };

    const updatedPhotos = [...existingPhotos];
    updatedPhotos[photoIndex] = updatedPhoto;
    
    await certificateService.updateCertificate(id, { fotos: updatedPhotos }, {});
    
    res.json(updatedPhoto);
  }),
);

// ==================== PDF GENERATION ENDPOINTS ====================

/**
 * Generar PDF de un borrador (preview, no sube a Drive)
 */
router.post(
  "/drafts/:id/generate-pdf",
  adminGuard,
  asyncHandler(async (req, res) => {
    if (!canGenerateReports(req.user)) {
      return res.status(403).json({
        message: "SUPERVISOR no puede crear informes",
        code: "INSUFFICIENT_PERMISSIONS",
      });
    }

    const { id } = req.params;
    const { selectedPhotoIds, selectedSections } = req.body;

    const draft = await draftService.getDraftById(id);
    
    if (!draft.inspeccionCompleta) {
      return res.status(400).json({
        message: "El borrador no tiene datos de inspección completa",
        code: "MISSING_INSPECTION_DATA",
      });
    }

    const draftInspector = String(draft.inspeccionCompleta?.inspector || "").trim();
    const draftDirector = String(draft.inspeccionCompleta?.directorTecnico || "").trim();
    if (!draftInspector || !draftDirector) {
      return res.status(400).json({
        message: "Inspector y Director Técnico son requeridos para generar el informe.",
        code: "MISSING_SIGNATURE_ROLES",
      });
    }

    const pdfBuffer = await pdfService.generatePdf(
      draft,
      selectedPhotoIds,
      selectedSections,
    );

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Length", pdfBuffer.length);
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="INF_${draft.empresa || 'DRAFT'}_${draft.numCert || 'DRAFT'}_${draft.serial || 'SERIAL'}.pdf"`
    );
    res.status(200).end(pdfBuffer);
  }),
);

/**
 * Generar PDF de un certificado y subirlo a Drive
 * Reemplaza el documento de informe existente
 */
router.post(
  "/certificates/:id/generate-pdf",
  adminGuard,
  asyncHandler(async (req, res) => {
    if (!canGenerateReports(req.user)) {
      return res.status(403).json({
        message: "SUPERVISOR no puede crear informes",
        code: "INSUFFICIENT_PERMISSIONS",
      });
    }

    const { id } = req.params;
    const { selectedPhotoIds, selectedSections, uploadToDrive = true } = req.body;

    const certificate = await certificateService.getCertificateById(id);
    
    if (!certificate.inspeccionCompleta) {
      return res.status(400).json({
        message: "El certificado no tiene datos de inspección completa",
        code: "MISSING_INSPECTION_DATA",
      });
    }

    const certInspector = String(certificate.inspeccionCompleta?.inspector || "").trim();
    const certDirector = String(certificate.inspeccionCompleta?.directorTecnico || "").trim();
    if (!certInspector || !certDirector) {
      return res.status(400).json({
        message: "Inspector y Director Técnico son requeridos para generar el informe.",
        code: "MISSING_SIGNATURE_ROLES",
      });
    }

    if (uploadToDrive) {
      // Generar y subir a Drive
      const { pdfUrl, pdfFileId, storage } = await pdfService.generateAndUploadPdf(
        certificate,
        selectedPhotoIds,
        selectedSections,
      );

      // Actualizar link del informe en el certificado
      const existingLinks = certificate.links || {};
      const updatedLinks = {
        ...existingLinks,
        informes: pdfUrl || existingLinks.informes,
      };

      await certificateService.updateCertificate(
        id,
        {
          links: updatedLinks,
          ...(storage?.rootFolderId ? { storage } : {}),
        },
        {},
      );

      res.json({
        success: true,
        pdfUrl,
        pdfFileId,
        message: "PDF generado y subido a Drive exitosamente",
      });
    } else {
      // Solo generar y descargar
      const pdfBuffer = await pdfService.generatePdf(
        certificate,
        selectedPhotoIds,
        selectedSections,
      );

      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Length", pdfBuffer.length);
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="INF_${certificate.empresa}_${certificate.numCert}_${certificate.serial}.pdf"`
      );
      res.status(200).end(pdfBuffer);
    }
  }),
);

// ==================== CERTIFICATE DOCUMENT GENERATION ====================

/**
 * Genera el PDF del certificado de inspección usando el template .docm en Drive.
 * Solo disponible cuando resultado === "CUMPLE". Devuelve el blob PDF para previsualización.
 */
router.post(
  "/certificates/:id/generate-cert",
  adminGuard,
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const certificate = await certificateService.getCertificateById(id);

    if (certificate.resultado !== "CUMPLE") {
      return res.status(400).json({
        message: "Solo se puede generar certificado para registros que CUMPLEN",
        code: "NOT_CUMPLE",
      });
    }

    const pdfBuffer = await certDocService.generatePdf(certificate);
    const filename = `CERT_${certificate.empresa}_${certificate.numCert}_${certificate.serial || "S-N"}.pdf`;

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Length", pdfBuffer.length);
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.status(200).end(pdfBuffer);
  }),
);

/**
 * Genera el PDF del certificado y lo sube a Drive.
 * Si ya existe un CERT enlazado, lo mueve a Obsoletos antes de subir el nuevo.
 * Actualiza links.certificados en la BD con el nuevo enlace.
 */
router.post(
  "/certificates/:id/upload-cert",
  adminGuard,
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const certificate = await certificateService.getCertificateById(id);

    if (certificate.resultado !== "CUMPLE") {
      return res.status(400).json({
        message: "Solo se puede generar certificado para registros que CUMPLEN",
        code: "NOT_CUMPLE",
      });
    }

    // Archivar el CERT existente en Obsoletos antes de reemplazarlo.
    const existingCertLink = certificate.links?.certificados;
    if (existingCertLink && existingCertLink !== "#") {
      const existingFileId = driveService.extractFileIdFromLink(existingCertLink);
      if (existingFileId && certificate.storage?.obsoletosFolderId) {
        try {
          await driveService.moveToObsoletos(existingFileId, certificate.storage.obsoletosFolderId);
          logger.info("CERT anterior archivado en Obsoletos", { fileId: existingFileId });
        } catch (err) {
          logger.warn("No se pudo archivar el CERT anterior", { error: err.message });
        }
      }
    }

    const pdfBuffer = await certDocService.generatePdf(certificate);
    const filename = `CERT_${certificate.empresa}_${certificate.numCert}_${certificate.serial || "S-N"}.pdf`;

    // Garantizar que el árbol de carpetas del certificado existe.
    let storage = certificate.storage || {};
    if (!storage.rootFolderId) {
      storage = await driveService.ensureCertificateFolderTree(certificate.numCert);
    }

    const uploadResult = await driveService.uploadBufferFile({
      buffer: pdfBuffer,
      fileName: filename,
      mimeType: "application/pdf",
      folderId: storage.rootFolderId,
      appProperties: {
        NumCert: String(certificate.numCert),
        Serial: String(certificate.serial || ""),
        Usuario: certificate.empresa || "",
      },
    });

    const updatedLinks = { ...certificate.links, certificados: uploadResult.webViewLink };
    const storageUpdate = !certificate.storage?.rootFolderId ? { storage } : {};

    await certificateService.updateCertificate(id, { links: updatedLinks, ...storageUpdate }, {});

    res.json({
      success: true,
      certUrl: uploadResult.webViewLink,
      certFileId: uploadResult.id,
      message: "Certificado generado y subido exitosamente",
    });
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
    const inspectorName = normalizeInspectorName(req.body?.inspectorName || label);

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
      inspectorName: inspectorName || "",
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
      inspectorName: inspectorName || "",
    });

    res.status(201).json({
      token,
      tokenId,
      maxDevices,
      expiresAt: expiresAt?.toISOString() || null,
      inspectorName: inspectorName || null,
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
      inspectorName: t.inspectorName || "",
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

/**
 * Admin endpoint to list enrolled app devices.
 */
router.get(
  "/app/auth/devices",
  adminGuard,
  asyncHandler(async (_req, res) => {
    const devices = await appDevicesCollection();
    const list = await devices
      .find({}, { projection: { _id: 0, secretHash: 0 } })
      .sort({ lastSeenAt: -1, createdAt: -1 })
      .limit(500)
      .toArray();

    res.json(
      list.map((d) => ({
        deviceId: d.deviceId,
        inspectorName: String(d.inspectorName || "").trim() || null,
        status: d.status || "active",
        platform: d.platform || "unknown",
        appVersion: d.appVersion || "",
        createdAt: d.createdAt || null,
        lastSeenAt: d.lastSeenAt || null,
      })),
    );
  }),
);

/**
 * Admin endpoint to assign/change inspector for a device.
 */
router.put(
  "/app/auth/devices/:deviceId/inspector",
  adminGuard,
  asyncHandler(async (req, res) => {
    const deviceId = String(req.params?.deviceId || "").trim().slice(0, 128);
    const inspectorName = normalizeInspectorName(req.body?.inspectorName);

    if (!deviceId || deviceId.length < 8) {
      return res.status(400).json({
        message: "deviceId inválido",
        code: "BAD_REQUEST",
      });
    }

    if (!inspectorName) {
      return res.status(400).json({
        message: "inspectorName es requerido",
        code: "MISSING_INSPECTOR_NAME",
      });
    }

    const devices = await appDevicesCollection();
    const result = await devices.updateOne(
      { deviceId },
      {
        $set: {
          inspectorName,
          updatedAt: new Date(),
        },
      },
    );

    if (result.matchedCount === 0) {
      return res.status(404).json({
        message: "Dispositivo no encontrado",
        code: "DEVICE_NOT_FOUND",
      });
    }

    logger.info("Device inspector updated", {
      deviceId,
      inspectorName,
      updatedBy: req.user.username,
    });

    res.json({ ok: true, deviceId, inspectorName });
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
    const inspectorNameInput = normalizeInspectorName(req.body?.inspectorName);

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
            ...(inspectorNameInput ? { inspectorName: inspectorNameInput } : {}),
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
          inspectorName:
            normalizeInspectorName(updateResult?.inspectorName || updateResult?.label) ||
            inspectorNameInput ||
            "",
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
      inspectorName: inspectorNameInput || "",
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
        inspector: String(device.inspectorName || "").trim() || undefined,
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

    res.json({ token, expiresAt, inspector: String(device.inspectorName || "").trim() || null });
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

    // App sync must not create/update `FOR` links from workbook flows.
    // Keep legacy support in other routes, but force formatos off here.
    draftData.links = {
      ...(draftData.links && typeof draftData.links === "object" ? draftData.links : {}),
      formatos: "#",
    };

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

    // App sync no longer uses workbook outputs.
    const ENABLE_AUTO_PDF = false;

    const deviceInspector = String(req.appClient?.inspector || "").trim();
    const fallbackInspector = req.appClient?.deviceId
      ? `DISPOSITIVO ${String(req.appClient.deviceId).slice(0, 18)}`
      : "";
    inspectionData.inspector = deviceInspector || fallbackInspector || inspectionData.inspector || "";
    inspectionData.directorTecnico = "";

    const cargueDate = draftData.fechaCargue
      ? new Date(draftData.fechaCargue)
      : new Date();
    const cargueDateIso = Number.isNaN(cargueDate.getTime())
      ? new Date().toISOString().slice(0, 10)
      : cargueDate.toISOString().slice(0, 10);
    inspectionData.datosInforme = {
      ...(inspectionData.datosInforme || {}),
      fechaExpedicion: cargueDateIso,
    };

    const hasValidNumCert = Number.isFinite(Number(draftData.numCert)) && Number(draftData.numCert) > 0;
    if (!hasValidNumCert) {
      const db = await connect();
      const localId = String(draftData.localId || "").trim();
      let existingNumCert = null;

      if (localId) {
        const existingDraft = await db.collection("drafts").findOne(
          { localId },
          { projection: { _id: 0, numCert: 1 } },
        );
        const parsedExistingNumCert = Number(existingDraft?.numCert);
        if (Number.isFinite(parsedExistingNumCert) && parsedExistingNumCert > 0) {
          existingNumCert = parsedExistingNumCert;
        }
      }

      draftData.numCert =
        existingNumCert ||
        (await draftService.getNextDraftNumber(db));
    } else {
      draftData.numCert = Number(draftData.numCert);
    }

    let draftStorage = null;
    try {
      draftStorage = await driveService.ensureCertificateFolderTree(draftData.numCert);
    } catch (error) {
      logger.warn("Could not ensure draft drive tree before app sync", {
        numCert: draftData.numCert,
        error: error.message,
      });
    }
    let photoSectionFolders = { ...(draftStorage?.sectionFolders || {}) };

    // Prepare temporary files.
    const tempDir = path.join(__dirname, '..', 'uploads');
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

    const timestamp = Date.now();
    const pdfSourceExcelPath = path.join(tempDir, `inspection_pdf_source_${timestamp}.xlsx`);
    const pdfPath = path.join(tempDir, `inspection_${timestamp}.pdf`);

    const serialForName = draftData.serial || 'INSPECCION';
    const numCertForName = draftData.numCert || 'DRAFT';

    let draft;
    try {
      // 4) Upload photos to Drive and prepare photo metadata
      logger.info("Step 4: Processing photos for Drive upload");
      const processedPhotos = [];
      let photoUploadError = null;
      const uploadedPhotoFileIds = [];
      
      if (Array.isArray(inspectionData?.fotos)) {
        const dbFoldersForPhotos =
          photoFiles.length > 0 ? await driveService.getDriveFolders() : null;

        for (const photo of inspectionData.fotos) {
          if (!photo?.uploadedPath) {
            photoUploadError = {
              code: 'PHOTO_FILE_MISSING',
              category: photo.category || 'superficie',
              message: 'El archivo local de la foto no llegó al backend',
            };
            break;
          }

          try {
            const categoryKey = String(photo.category || 'otros');
            let photoTargetFolder =
              dbFoldersForPhotos?.INF || config.google.drive.parentFolderId;

            if (draftStorage?.registrosFotograficosFolderId) {
              let sectionFolderId = photoSectionFolders[categoryKey] || null;
              if (!sectionFolderId) {
                try {
                  const sectionName = draftService.getPhotoSectionFolderName(categoryKey);
                  const sectionFolder = await driveService.ensurePhotoSectionFolder(
                    draftStorage.registrosFotograficosFolderId,
                    sectionName,
                  );
                  sectionFolderId = sectionFolder?.id || null;
                  if (sectionFolderId) {
                    photoSectionFolders = {
                      ...photoSectionFolders,
                      [categoryKey]: sectionFolderId,
                    };
                  }
                } catch (sectionErr) {
                  logger.warn('Could not ensure section folder for photo upload', {
                    category: categoryKey,
                    numCert: numCertForName,
                    error: sectionErr.message,
                  });
                }
              }

              if (sectionFolderId) {
                photoTargetFolder = sectionFolderId;
              }
            }

            // Subir foto a Drive
            const photoFileName = `FOTO_${serialForName}_${photo.category || 'foto'}_${Date.now()}.jpg`;
            const photoUploadResult = await driveService.uploadFile({
              localPath: photo.uploadedPath,
              fileName: photoFileName,
              mimeType: photo.uploadedMimeType || 'image/jpeg',
              appProperties: {
                NumCert: String(numCertForName),
                Serial: String(serialForName),
                Category: photo.category || 'general',
              },
              folderId: photoTargetFolder,
            });

            processedPhotos.push({
              id: photo.id || `photo_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
              category: photo.category || 'superficie',
              description: photo.description || '',
              timestamp: photo.timestamp || new Date().toISOString(),
              includeInPdf: photo.includeInPdf !== false,
              driveFileId: photoUploadResult?.id || null,
              driveUrl: photoUploadResult?.webViewLink || null,
              thumbnailUrl:
                driveService.getThumbnailUrl(photoUploadResult?.id) ||
                photoUploadResult?.thumbnailLink ||
                null,
            });

            if (photoUploadResult?.id) {
              uploadedPhotoFileIds.push(photoUploadResult.id);
            }

            logger.info("Photo uploaded to Drive", {
              category: photo.category,
              fileId: photoUploadResult?.id,
            });
          } catch (photoErr) {
            logger.warn("Failed to upload photo to Drive", {
              category: photo.category,
              error: photoErr.message,
            });
            photoUploadError = {
              code: 'PHOTO_UPLOAD_FAILED',
              category: photo.category || 'superficie',
              message: photoErr.message,
            };
            break;
          }
        }
      }

      if (photoUploadError) {
        if (uploadedPhotoFileIds.length > 0) {
          for (const fileId of uploadedPhotoFileIds) {
            try {
              await driveService.deleteFile(fileId);
            } catch (cleanupErr) {
              logger.warn('Could not clean up partially uploaded photo', {
                fileId,
                error: cleanupErr.message,
              });
            }
          }
        }

        return res.status(502).json({
          message: 'Error cargando fotos a Drive. Reintente sincronizar.',
          code: 'PHOTO_UPLOAD_FAILED',
          detail: photoUploadError,
        });
      }

      logger.info("Step 4 complete: Photos processed", { 
        total: processedPhotos.length,
        uploadedToDrive: processedPhotos.filter(p => p.driveFileId).length,
      });

      // 5) Create draft with inspection data and photo metadata
      logger.info("Step 5: Creating draft with full inspection data");
      const files = {};

      if (ENABLE_AUTO_PDF) {
        files.informes = [{
          path: pdfPath,
          originalname: `${serialForName}_${timestamp}.pdf`,
          mimetype: 'application/pdf'
        }];
      }

      if (draftStorage) {
        draftStorage = {
          ...draftStorage,
          sectionFolders: photoSectionFolders,
        };
        draftData.storage = draftStorage;
      }

      if (draftStorage?.rootFolderLink) {
        draftData.links = {
          ...(draftData.links || {}),
          driveFolder: draftStorage.rootFolderLink,
        };
      }

      // NUEVO: Pasar la inspección completa y las fotos procesadas al draft
      draftData.inspeccionCompleta = inspectionData;
      draftData.fotos = processedPhotos;

      draft = await draftService.createDraft(draftData, files);
      logger.info("Step 5 complete: Draft created with full inspection", { 
        draftId: draft?.id,
        hasInspeccionCompleta: !!draft?.hasInspeccionCompleta,
        photosCount: draft?.photosCount || 0,
      });
      logger.info("App draft sync completed", {
        draftId: draft?.id,
        elapsedMs: Date.now() - startedAt,
      });

      res.status(201).json(draft);
    } finally {
      // Always clean up temporary files.
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
    const companies = await companyService.getAllCompanyProfiles();
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
  "/admin/reports/daily-inspector",
  adminGuard,
  asyncHandler(async (req, res) => {
    const date = String(req.query?.date || "").trim();
    const inspector = normalizeInspectorName(req.query?.inspector || "");

    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ message: "date debe tener formato YYYY-MM-DD", code: "BAD_REQUEST" });
    }
    if (!inspector) {
      return res.status(400).json({ message: "inspector es requerido", code: "BAD_REQUEST" });
    }

    const start = new Date(`${date}T00:00:00.000Z`);
    const end = new Date(`${date}T23:59:59.999Z`);

    const inspectorRegex = new RegExp(`^${inspector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i");
    const db = await connect();

    const [certificates, drafts, sites] = await Promise.all([
      db
        .collection("certificates")
        .find({
          fechaCargue: { $gte: start, $lte: end },
          "inspeccionCompleta.inspector": inspectorRegex,
        })
        .sort({ createdAt: 1, numCert: 1 })
        .toArray(),
      db
        .collection("drafts")
        .find({
          fechaCargue: { $gte: start, $lte: end },
          "inspeccionCompleta.inspector": inspectorRegex,
        })
        .sort({ createdAt: 1, numCert: 1 })
        .toArray(),
      db
        .collection("inventory_sites")
        .find({}, { projection: { name: 1, address: 1, latitud: 1, longitud: 1 } })
        .toArray(),
    ]);

    const allRows = [...certificates, ...drafts]
      .sort((a, b) => {
        const aTs = new Date(a?.createdAt || a?.fechaCargue || 0).getTime();
        const bTs = new Date(b?.createdAt || b?.fechaCargue || 0).getTime();
        if (aTs !== bTs) return aTs - bTs;
        return Number(a?.numCert || 0) - Number(b?.numCert || 0);
      });

    const templatePath = path.join(__dirname, "..", "templates", "new-visita.xlsx");
    if (!fs.existsSync(templatePath)) {
      return res.status(500).json({
        message: "Plantilla [NEW] - VISITA no encontrada en el servidor",
        code: "MISSING_TEMPLATE",
      });
    }

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(templatePath);
    const ws = workbook.getWorksheet("Hoja1") || workbook.worksheets[0];

    const templateRowStart = 10;
    const templateRowEnd = 17;
    const templateRowCount = templateRowEnd - templateRowStart + 1;

    const toText = (value) => String(value || "").trim();
    const normalizeType = (value) => (toText(value).toUpperCase() === "TOTAL" ? "TOT" : "PAR");
    const formatCoordinates = (info) => {
      const explicit = toText(info?.coordenadas);
      if (explicit) return explicit;

      const lat = parseCoordinate(info?.latitud);
      const lng = parseCoordinate(info?.longitud);
      if (Number.isFinite(lat) && Number.isFinite(lng)) {
        return `${lat.toFixed(6)}, ${lng.toFixed(6)}`;
      }

      return "";
    };

    ws.getCell("D5").value = date;
    ws.getCell("C19").value = inspector;

    if (allRows.length > templateRowCount) {
      ws.spliceRows(templateRowEnd + 1, 0, ...Array(allRows.length - templateRowCount).fill([]));
    }

    const siteByName = new Map(
      sites
        .filter((site) => normalizePlaceKey(site?.name))
        .map((site) => [normalizePlaceKey(site.name), site]),
    );
    const reverseGeocodeCache = new Map();

    for (const [index, item] of allRows.entries()) {
      const rowNumber = templateRowStart + index;
      const inspection = item?.inspeccionCompleta || {};
      const info = inspection?.informacionItem || {};
      const client = inspection?.datosCliente || {};
      const resultado = toText(item?.resultado).toUpperCase();
      const efectiva = resultado === "CUMPLE" ? "SI" : "NO";
      const location = toText(info?.nombreUbicacion || info?.direccion || "");
      const capacity = toText(info?.capacidadNominal || info?.capacidad || "");
      const place =
        resolveInspectionPlace({ info, client, sites, siteByName }) ||
        await reverseGeocodePlace(info, reverseGeocodeCache);
      const coordinates = formatCoordinates(info);
      const observation = efectiva === "NO" ? "VISITA NO EFECTIVA" : "";

      ws.getCell(`B${rowNumber}`).value = location;
      ws.getCell(`E${rowNumber}`).value = toText(item?.empresa);
      ws.getCell(`F${rowNumber}`).value = toText(item?.serial);
      ws.getCell(`H${rowNumber}`).value = capacity;
      ws.getCell(`I${rowNumber}`).value = normalizeType(item?.tipoInspeccion || info?.tipoInspeccion);
      ws.getCell(`J${rowNumber}`).value = toText(item?.numCert);
      ws.getCell(`K${rowNumber}`).value = efectiva;
      ws.getCell(`L${rowNumber}`).value = observation;
      ws.getCell(`M${rowNumber}`).value = resultado === "CUMPLE" ? "C" : "NC";
      ws.getCell(`N${rowNumber}`).value = observation;
      ws.getCell(`O${rowNumber}`).value = place;
      ws.getCell(`P${rowNumber}`).value = coordinates;
    }

    for (let i = allRows.length; i < templateRowCount; i += 1) {
      const rowNumber = templateRowStart + i;
      ["B", "E", "F", "H", "I", "J", "K", "L", "M", "N", "O", "P"].forEach((col) => {
        ws.getCell(`${col}${rowNumber}`).value = "";
      });
    }

    const safeInspector = inspector.replace(/[^a-zA-Z0-9_-]+/g, "_").slice(0, 50) || "INSPECTOR";
    const fileName = `Reporte_${date}_${safeInspector}.xlsx`;
    const buffer = await workbook.xlsx.writeBuffer();

    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
    res.status(200).end(Buffer.from(buffer));
  }),
);

router.get(
  "/admin/reports/inspectors",
  adminGuard,
  asyncHandler(async (_req, res) => {
    const db = await connect();
    const [certificateInspectors, draftInspectors, deviceInspectors, tokenInspectors] = await Promise.all([
      db.collection("certificates").distinct("inspeccionCompleta.inspector"),
      db.collection("drafts").distinct("inspeccionCompleta.inspector"),
      db.collection("app_devices").distinct("inspectorName"),
      db.collection("enrollment_tokens").distinct("inspectorName"),
    ]);

    const names = new Set(
      [
        ...certificateInspectors,
        ...draftInspectors,
        ...deviceInspectors,
        ...tokenInspectors,
      ]
        .map(normalizeInspectorName)
        .filter(Boolean),
    );

    res.json(
      Array.from(names).sort((a, b) =>
        a.localeCompare(b, "es", { sensitivity: "base" }),
      ),
    );
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

router.get(
  "/admin/companies/:name/profile",
  adminGuard,
  asyncHandler(async (req, res) => {
    const profile = await companyService.getCompanyProfile(req.params.name);
    res.json(profile);
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
