// Archivo de rutas de la API REST
// Define todos los endpoints del sistema: auth, certificados, borradores, administración, etc.
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

// Crear router principal de Express
const router = express.Router();

// Configurar middleware de carga de archivos con multer
const upload = multer({
  dest: config.upload.dest,                    // Directorio temporal
  limits: { fileSize: config.upload.maxFileSize },  // Límite de tamaño de archivo
});

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
  asyncHandler(async (req, res) => {
    const users = await userService.getAllUsers();
    res.json(users);
  }),
);

router.post(
  "/auth/login",
  asyncHandler(async (req, res) => {
    const { username, password } = req.body;
    const result = await userService.authenticateUser(username, password);
    res.json(result);
  }),
);

router.get(
  "/certificates",
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

    
    const db = await (await import("../db.js")).connect();
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
        
        stream.on("error", () => {
          try {
            if (!res.headersSent) res.end();
          } catch {}
        });
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
        await inner.finalize();
      }
    }

    await main.finalize();
  }),
);

router.post(
  "/certificates",
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
    res.status(201).json(created);
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
