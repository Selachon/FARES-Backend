// Archivo de rutas de la API REST
// Define todos los endpoints del sistema: auth, certificados, borradores, administración, etc.
import express from "express";
import multer from "multer";
import rateLimit from "express-rate-limit";
import jwt from "jsonwebtoken";
import { config } from "../config.js";
import { asyncHandler } from "../utils.js";
import { emailService } from "../emailService.js";
import { userService } from "../userService.js";
import { certificateService } from "../certificateService.js";
import { configService } from "../configService.js";
import { draftService } from "../draftService.js";
import { adminGuard, healthMiddleware, userGuard, appGuard, authenticate } from "../middleware.js";
import { notificationService } from "../notificationService.js";
import { performanceMonitor } from "../performanceMonitor.js";
import { connect } from "../db.js";
import archiver from "archiver";
import { ObjectId } from "mongodb";
import { driveService } from "../driveService.js";
import { excelService } from "../excelService.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Crear router principal de Express
const router = express.Router();

// Rate limiter para login (5 intentos por 15 minutos)
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 5, // 5 intentos
  message: {
    message: "Demasiados intentos de inicio de sesión. Intenta nuevamente en 15 minutos.",
    code: "TOO_MANY_REQUESTS"
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// Configurar middleware de carga de archivos con multer
const upload = multer({
  dest: config.upload.dest,                    // Directorio temporal
  limits: { fileSize: config.upload.maxFileSize },  // Límite de tamaño de archivo
});

// ============================================================
// SSE - Notificaciones en tiempo real para usuarios USER
// ============================================================
router.get(
  "/notifications/stream",
  authenticate,
  (req, res) => {
    // Solo usuarios con rol USER reciben notificaciones
    if (req.user.role !== "USER") {
      return res.status(403).json({ message: "Solo para clientes", code: "FORBIDDEN" });
    }

    // Configurar SSE
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

    // Heartbeat cada 30s para mantener la conexión viva
    const heartbeat = setInterval(() => {
      try { res.write(": heartbeat\n\n"); } catch { /* ignore */ }
    }, 30_000);

    // Registrar cliente
    const { username } = req.user;
    notificationService.addClient(username, res);

    // Limpieza al cerrar conexión
    req.on("close", () => {
      clearInterval(heartbeat);
      notificationService.removeClient(username, res);
    });
  },
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
  asyncHandler(async (req, res) => {
    const result = await emailService.sendContactEmail(req.body);
    res.json(result);
  }),
);

router.get(
  "/auth/users",
  authenticate,
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
    const user = await userService.authenticateUser(username, password);
    
    // Crear token JWT
    const token = jwt.sign(
      {
        username: user.username,
        role: user.role,
        empresa: user.empresa
      },
      config.jwt.secret,
      { expiresIn: config.jwt.expiresIn }
    );
    
    // Establecer cookie httpOnly
    res.cookie(config.jwt.cookie.name, token, {
      httpOnly: config.jwt.cookie.httpOnly,
      secure: config.jwt.cookie.secure,
      sameSite: config.jwt.cookie.sameSite,
      maxAge: config.jwt.cookie.maxAge
    });
    
    // Retornar datos del usuario (sin token en body)
    res.json(user);
  }),
);

router.post(
  "/auth/logout",
  asyncHandler(async (req, res) => {
    // Limpiar cookie de sesión
    res.clearCookie(config.jwt.cookie.name);
    res.json({ message: "Sesión cerrada exitosamente" });
  }),
);

router.get(
  "/certificates",
  authenticate,
  asyncHandler(async (req, res) => {
    const certificates = await certificateService.getAllCertificates();
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
    { name: "formatos", maxCount: 1 },
    { name: "certificados", maxCount: 1 },
  ]),
  asyncHandler(async (req, res) => {
    const certificate = await certificateService.createCertificate(
      req.body,
      req.files,
    );
    // Notificar a los usuarios asignados via SSE
    notificationService.notifyCertificateCreated(certificate);
    res.status(201).json(certificate);
  }),
);

router.put(
  "/certificates/:id",
  adminGuard,
  upload.fields([
    { name: "informes", maxCount: 1 },
    { name: "formatos", maxCount: 1 },
    { name: "certificados", maxCount: 1 },
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
    { name: "formatos", maxCount: 1 },
    { name: "certificados", maxCount: 1 },
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
    { name: "formatos", maxCount: 1 },
    { name: "certificados", maxCount: 1 },
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
    // Notificar a los usuarios asignados via SSE
    notificationService.notifyCertificateCreated(created);
    res.status(201).json(created);
  }),
);

// ============================================================
// MOBILE APP ENDPOINTS
// Endpoints específicos para la aplicación móvil offline
// Usa appGuard en lugar de adminGuard para autenticación simple
// ============================================================

router.post(
  "/app/drafts",
  appGuard,
  asyncHandler(async (req, res) => {
    // Receive full inspection data from mobile app
    const { inspeccionCompleta, ...draftData } = req.body;

    if (!inspeccionCompleta) {
      return res.status(400).json({
        message: "inspeccionCompleta es requerido",
        code: "MISSING_INSPECTION_DATA"
      });
    }

    // Validar campos básicos de draftData
    if (!draftData.serial || !draftData.empresa) {
      return res.status(400).json({
        message: "serial y empresa son requeridos",
        code: "MISSING_REQUIRED_FIELDS"
      });
    }

    // Parse if it comes as string
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

    // 1. Fill Excel template
    const workbook = await excelService.fillTemplate(inspectionData);

    // 2. Save Excel to temp file
    const tempDir = path.join(__dirname, '..', 'uploads');
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

    const timestamp = Date.now();
    const excelPath = path.join(tempDir, `inspection_${timestamp}.xlsx`);
    await excelService.saveWorkbook(workbook, excelPath);

    // 3. Create files object for draft service
    const files = {
      formatos: [{
        path: excelPath,
        originalname: `${draftData.serial || 'INSPECCION'}_${timestamp}.xlsx`,
        mimetype: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      }]
    };

    // 4. Create draft with the Excel file
    const draft = await draftService.createDraft(draftData, files);

    // 5. Cleanup temp file
    try {
      fs.unlinkSync(excelPath);
    } catch (err) {
      // Ignore cleanup errors
    }

    res.status(201).json(draft);
  }),
);

router.get(
  "/app/health",
  asyncHandler(async (req, res) => {
    // Simple health check for mobile app
    res.json({ 
      status: "ok", 
      timestamp: new Date().toISOString(),
      version: "1.0.0"
    });
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
