// Importaciones de módulos necesarios para las rutas
import express from "express";
import multer from "multer";
import { config } from "../config.js";
import { asyncHandler } from "../utils.js";
import { emailService } from "../emailService.js";
import { userService } from "../userService.js";
import { certificateService } from "../certificateService.js";
import { configService } from "../configService.js";
import { draftService } from "../draftService.js";
import { adminGuard, healthMiddleware, userGuard } from "../middleware.js";
import { performanceMonitor } from "../performanceMonitor.js";
import archiver from "archiver";
import { ObjectId } from "mongodb";
import { driveService } from "../driveService.js";

// Router de Express para agrupar todas las rutas de la API
const router = express.Router();

// Configuración de Multer para subida de archivos
const upload = multer({ 
  dest: config.upload.dest,                              // Directorio temporal
  limits: { fileSize: config.upload.maxFileSize }        // Tamaño máximo: 10MB
});

// Rutas de salud del sistema
router.get("/health", healthMiddleware); // Health check detallado
router.get("/metrics", adminGuard, asyncHandler(async (req, res) => {
  const metrics = performanceMonitor.getMetrics(); // Métricas de rendimiento
  res.json(metrics);
}));

// Rutas públicas
router.post("/contact", asyncHandler(async (req, res) => {
  // Envía email de contacto desde formulario web
  const result = await emailService.sendContactEmail(req.body);
  res.json(result);
}));

// Rutas de autenticación
router.get("/auth/users", asyncHandler(async (req, res) => {
  // Obtiene todos los usuarios del sistema
  const users = await userService.getAllUsers();
  res.json(users);
}));

router.post("/auth/login", asyncHandler(async (req, res) => {
  // Autentica usuario con username y password
  const { username, password } = req.body;
  const result = await userService.authenticateUser(username, password);
  res.json(result);
}));

router.get("/auth/users", asyncHandler(async (req, res) => {
  const users = await userService.getAllUsers();
  res.json(users);
}));

router.post("/auth/login", asyncHandler(async (req, res) => {
  const { username, password } = req.body;
  const result = await userService.authenticateUser(username, password);
  res.json(result);
}));

// Rutas de certificados
router.get("/certificates", asyncHandler(async (req, res) => {
  // Obtiene todos los certificados del sistema
  const certificates = await certificateService.getAllCertificates();
  res.json(certificates);
}));

router.post("/certificates/download",
  userGuard,
  asyncHandler(async (req, res) => {
    const { ids } = req.body || {};
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ message: "ids requeridos", code: "BAD_REQUEST" });
    }

    const { username, empresa } = req.user;

    // Trae certificados por ID
    const db = await (await import("../db.js")).connect();
    const objIds = ids.map((id) => new ObjectId(id));
    const certs = await db
      .collection("certificates")
      .find({ _id: { $in: objIds } })
      .toArray();

    if (!certs.length) {
      return res.status(404).json({ message: "No se encontraron certificados", code: "NOT_FOUND" });
    }

    // Valida pertenencia estricta
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

    // Construye lista por certificado: archivos existentes (no "#")
    const certPayloads = allowed.map((c) => {
      const links = c.links || {};
      const candidates = [
        { kind: "informes", link: links.informes },
        { kind: "formatos", link: links.formatos },
        { kind: "certificados", link: links.certificados },
      ];

      const files = candidates
        .map((x) => ({ ...x, fileId: driveService.extractFileIdFromLink(x.link) }))
        .filter((x) => x.fileId);

      return {
        id: c._id.toString(),
        numCert: c.numCert,
        serial: c.serial,
        files,
      };
    });

    // Si seleccionó 1 registro
    if (certPayloads.length === 1) {
      const one = certPayloads[0];

      // Si tiene 1 archivo: se entrega tal cual (sin zip)
      if (one.files.length === 1) {
        const f = one.files[0];
        const { name, stream } = await driveService.downloadFileStream(f.fileId);

        res.setHeader("Content-Type", "application/octet-stream");
        res.setHeader("Content-Disposition", `attachment; filename="${name}"`);
        stream.on("error", () => {
          // si el stream falla, cortamos
          try { res.end(); } catch {}
        });
        return stream.pipe(res);
      }

      // Si tiene 2 o 3: zip por certificado "<#> - <serial>.zip"
      const zipName = `${one.numCert} - ${one.serial}.zip`;

      res.setHeader("Content-Type", "application/zip");
      res.setHeader("Content-Disposition", `attachment; filename="${zipName}"`);

      const archive = archiver("zip", { zlib: { level: 9 } });
      archive.on("error", (err) => { throw err; });
      archive.pipe(res);

      for (const f of one.files) {
        const { name, stream } = await driveService.downloadFileStream(f.fileId);
        archive.append(stream, { name }); // nombre original SIN CAMBIOS
      }

      await archive.finalize();
      return;
    }

    // Si seleccionó más de 1: zip general "Certificados <EMPRESA>.zip"
    const mainName = `Certificados ${empresa}.zip`;

    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="${mainName}"`);

    const main = archiver("zip", { zlib: { level: 9 } });
    main.on("error", (err) => { throw err; });
    main.pipe(res);

    // Cada certificado:
    // - si tiene 1 archivo: lo mete directo a la raíz (con nombre original)
    // - si tiene >1: crea zip interno "<#> - <serial>.zip"
    for (const c of certPayloads) {
      if (c.files.length === 1) {
        const f = c.files[0];
        const { name, stream } = await driveService.downloadFileStream(f.fileId);
        main.append(stream, { name });
      } else {
        const innerZipName = `${c.numCert} - ${c.serial}.zip`;

        // Creamos un zip “virtual” como stream y lo metemos dentro del zip principal
        const inner = archiver("zip", { zlib: { level: 9 } });
        inner.on("error", (err) => { throw err; });

        main.append(inner, { name: innerZipName });

        for (const f of c.files) {
          const { name, stream } = await driveService.downloadFileStream(f.fileId);
          inner.append(stream, { name }); // nombre original SIN CAMBIOS
        }

        await inner.finalize();
      }
    }

    await main.finalize();
  })
);

router.post("/certificates", 
  upload.fields([  // Sube múltiples archivos: informes, formatos, certificados
    { name: "informes", maxCount: 1 },
    { name: "formatos", maxCount: 1 },
    { name: "certificados", maxCount: 1 },
  ]),
  asyncHandler(async (req, res) => {
    // Crea nuevo certificado con archivos adjuntos
    const certificate = await certificateService.createCertificate(req.body, req.files);
    res.status(201).json(certificate); // 201: Created
  })
);

router.put("/certificates/:id",
  adminGuard, // Solo administradores pueden actualizar
  upload.fields([
    { name: "informes", maxCount: 1 },
    { name: "formatos", maxCount: 1 },
    { name: "certificados", maxCount: 1 },
  ]),
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    // Actualiza certificado existente
    const certificate = await certificateService.updateCertificate(id, req.body, req.files);
    res.json(certificate);
  })
);

router.delete("/certificates/bulk", 
  asyncHandler(async (req, res) => {
    const { items } = req.body;
    // Elimina múltiples certificados en una sola operación
    const result = await certificateService.deleteCertificates(items);
    res.json(result);
  })
);

// =====================
// Rutas de BORRADORES (solo ADMIN)
// =====================
router.get("/drafts",
  adminGuard,
  asyncHandler(async (req, res) => {
    const drafts = await draftService.getAllDrafts();
    res.json(drafts);
  })
);

router.post("/drafts",
  adminGuard,
  upload.fields([
    { name: "informes", maxCount: 1 },
    { name: "formatos", maxCount: 1 },     // FOR
    { name: "certificados", maxCount: 1 },
  ]),
  asyncHandler(async (req, res) => {
    const draft = await draftService.createDraft(req.body, req.files || {});
    res.status(201).json(draft);
  })
);

router.put("/drafts/:id",
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
  })
);

router.delete("/drafts/bulk",
  adminGuard,
  asyncHandler(async (req, res) => {
    const { ids } = req.body;
    const result = await draftService.deleteDraftsByIds(ids);
    res.json(result);
  })
);

router.post("/drafts/:id/publish",
  adminGuard,
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    const created = await draftService.publishDraft(id);
    res.status(201).json(created);
  })
);

// Rutas de configuración (solo administradores)
router.get("/admin/drive-folders", 
  adminGuard,
  asyncHandler(async (req, res) => {
    // Obtiene configuración de carpetas de Drive
    const folders = await configService.getDriveFolders();
    res.json(folders);
  })
);

router.put("/admin/drive-folders",
  adminGuard,
  asyncHandler(async (req, res) => {
    // Actualiza configuración de carpetas de Drive
    const folders = await configService.updateDriveFolders(req.body);
    res.json(folders);
  })
);

router.get("/drive/fileinfo",
  adminGuard,
  asyncHandler(async (req, res) => {
    const { id } = req.query;
    // Obtiene información de archivo en Drive
    const fileInfo = await configService.getDriveFileInfo(id);
    res.json(fileInfo);
  })
);

// Rutas de gestión de usuarios (solo administradores)
router.put("/admin/users/password",
  adminGuard,
  asyncHandler(async (req, res) => {
    const { username, newPassword } = req.body;
    // Actualiza contraseña de usuario (admin)
    const result = await userService.adminUpdateUserPassword(username, newPassword);
    res.json(result);
  })
);

router.put("/admin/users/:username/password",
  adminGuard,
  asyncHandler(async (req, res) => {
    const { username } = req.params;
    const { newPassword } = req.body;
    // Actualiza contraseña de usuario (con validación)
    const result = await userService.updateUserPassword(username, newPassword);
    res.json(result);
  })
);

// Exporta el router para ser usado en el servidor principal
export default router;