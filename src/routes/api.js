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
import { adminGuard, healthMiddleware } from "../middleware.js";
import { performanceMonitor } from "../performanceMonitor.js";

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
  asyncHandler(async (req, res) => {
    const draft = await draftService.createDraft(req.body);
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