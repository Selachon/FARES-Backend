// Servicio de integración con Google Drive
// Maneja autenticación OAuth, subida, descarga y gestión de archivos en Google Drive
import { google } from "googleapis";
import fs from "fs";
import https from "https";
import { config } from "./config.js";
import { logger, retryOperation, pickFirst } from "./utils.js";
import { performanceMonitor } from "./performanceMonitor.js";
import { connect } from "./db.js";

class DriveService {
  constructor() {
    this.oauth2 = null;
    this.drive = null;
    this.initializeAuth();
  }

  // Inicializar autenticación OAuth2 con Google
  initializeAuth() {
    // Crear cliente OAuth2 con credenciales de config
    this.oauth2 = new google.auth.OAuth2(
      config.google.oauth.clientId,
      config.google.oauth.clientSecret,
    );
    // Establecer credenciales con token de refresco
    this.oauth2.setCredentials({
      refresh_token: config.google.oauth.refreshToken,
    });

    
    // Crear cliente de Drive API v3 con autenticación
    this.drive = google.drive({ version: "v3", auth: this.oauth2 });

    
    // Realizar calentamiento de autenticación para verificar credenciales
    this.warmUpAuth();
  }

  
  // Calentamiento de autenticación para verificar credenciales al iniciar
  async warmUpAuth() {
    try {
      await this.oauth2.getAccessToken();
      logger.info("Google OAuth warm-up successful");
    } catch (error) {
      logger.warn("Google OAuth warm-up failed", { error: error.message });
    }
  }

  
  // Cache de configuración de carpetas para reducir consultas a BD
  driveFoldersCache = null;
  driveFoldersCacheUntil = 0;
  
  // Cache de carpetas creadas en Drive para evitar búsquedas repetidas
  // Key: "parentId:folderName", Value: { id, name, webViewLink, cachedAt }
  folderCache = new Map();
  FOLDER_CACHE_TTL = 10 * 60 * 1000; // 10 minutos

  
  // Obtener configuración de carpetas de Drive desde BD con caché
  async getDriveFolders() {
    const now = Date.now();

    
    // Usar caché si está vigente (1 minuto)
    if (this.driveFoldersCache && now < this.driveFoldersCacheUntil) {
      return this.driveFoldersCache;
    }

    try {
      const db = await connect();

      // Obtener configuración desde colección config
      const doc = await db
        .collection("config")
        .findOne({ key: "driveFolders" }, { projection: { _id: 0, value: 1 } });

      const folders = doc?.value || {};

      // Actualizar caché
      this.driveFoldersCache = folders;
      this.driveFoldersCacheUntil = now + 60_000; // 1 minuto de caché

      return folders;
    } catch (error) {
      logger.warn(
        "No se pudieron cargar driveFolders desde Mongo, usando env/config.js",
        {
          error: error.message,
        },
      );
      return {};
    }
  }

  
  async getFileInfo(fileId) {
    return retryOperation(async () => {
      const response = await this.drive.files.get({
        fileId,
        fields: "id,name,parents,mimeType,driveId",
        supportsAllDrives: true,
      });
      return response.data;
    });
  }

  // Obtener metadata completa de archivo (incluye createdTime para obsoletos)
  async getFileMetadata(fileId) {
    return retryOperation(async () => {
      const response = await this.drive.files.get({
        fileId,
        fields: "id,name,parents,mimeType,driveId,createdTime,modifiedTime,description,webViewLink",
        supportsAllDrives: true,
      });
      return response.data;
    });
  }

  // Crear carpeta en Drive
  async createFolder(name, parentFolderId) {
    performanceMonitor.trackDriveOperation();
    
    return retryOperation(async () => {
      const response = await this.drive.files.create({
        requestBody: {
          name,
          mimeType: "application/vnd.google-apps.folder",
          parents: parentFolderId ? [parentFolderId] : [],
        },
        fields: "id,name,webViewLink",
        supportsAllDrives: true,
      });
      
      // Establecer permisos en la carpeta
      await this.setPermissions(response.data.id);
      
      return response.data;
    });
  }

  // Buscar carpeta por nombre dentro de un padre
  async findFolderByName(name, parentFolderId) {
    return retryOperation(async () => {
      const query = `name='${name}' and mimeType='application/vnd.google-apps.folder' and '${parentFolderId}' in parents and trashed=false`;
      const response = await this.drive.files.list({
        q: query,
        fields: "files(id,name,webViewLink)",
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      });
      return response.data.files?.[0] || null;
    });
  }

  // Asegurar que existe una carpeta (crear si no existe) - con cache
  async ensureFolder(name, parentFolderId) {
    const cacheKey = `${parentFolderId}:${name}`;
    const now = Date.now();
    
    // Verificar cache
    const cached = this.folderCache.get(cacheKey);
    if (cached && (now - cached.cachedAt) < this.FOLDER_CACHE_TTL) {
      return { id: cached.id, name: cached.name, webViewLink: cached.webViewLink };
    }
    
    // Buscar en Drive
    const existing = await this.findFolderByName(name, parentFolderId);
    if (existing) {
      // Guardar en cache
      this.folderCache.set(cacheKey, { ...existing, cachedAt: now });
      return existing;
    }
    
    // Crear carpeta
    const created = await this.createFolder(name, parentFolderId);
    // Guardar en cache
    this.folderCache.set(cacheKey, { ...created, cachedAt: now });
    return created;
  }
  
  // Limpiar cache de carpetas (útil si se renombran o eliminan)
  clearFolderCache() {
    this.folderCache.clear();
  }

  // Mover archivo a otra carpeta
  async moveFile(fileId, newParentFolderId, removeFromCurrentParent = true) {
    performanceMonitor.trackDriveOperation();
    
    return retryOperation(async () => {
      // Obtener padres actuales
      const current = await this.getFileInfo(fileId);
      const currentParents = current.parents || [];
      
      const response = await this.drive.files.update({
        fileId,
        addParents: newParentFolderId,
        removeParents: removeFromCurrentParent ? currentParents.join(",") : undefined,
        fields: "id,name,parents,webViewLink",
        supportsAllDrives: true,
      });
      
      return response.data;
    });
  }

  // Renombrar archivo
  async renameFile(fileId, newName) {
    performanceMonitor.trackDriveOperation();
    
    return retryOperation(async () => {
      const response = await this.drive.files.update({
        fileId,
        requestBody: { name: newName },
        fields: "id,name,webViewLink",
        supportsAllDrives: true,
      });
      return response.data;
    });
  }

  // Actualizar descripción de archivo
  async updateFileDescription(fileId, description) {
    performanceMonitor.trackDriveOperation();
    
    return retryOperation(async () => {
      const response = await this.drive.files.update({
        fileId,
        requestBody: { description },
        fields: "id,name,description",
        supportsAllDrives: true,
      });
      return response.data;
    });
  }

  // Mover archivo a obsoletos con renombre y descripción
  async moveToObsoletos(fileId, obsoletosFolderId) {
    // Obtener metadata del archivo
    const metadata = await this.getFileMetadata(fileId);
    const originalName = metadata.name || "archivo";
    const createdTime = metadata.createdTime ? new Date(metadata.createdTime) : new Date();
    
    // Formatear fecha DD-MM-YY
    const day = String(createdTime.getDate()).padStart(2, "0");
    const month = String(createdTime.getMonth() + 1).padStart(2, "0");
    const year = String(createdTime.getFullYear()).slice(-2);
    const dateStr = `${day}-${month}-${year}`;
    
    // Construir nuevo nombre: "<nombre> (DD-MM-YY).ext"
    const extMatch = originalName.match(/(\.[^.]+)$/);
    const ext = extMatch ? extMatch[1] : "";
    const nameWithoutExt = ext ? originalName.slice(0, -ext.length) : originalName;
    const newName = `${nameWithoutExt} (${dateStr})${ext}`;
    
    // Formatear fecha para descripción DD-MM-YYYY
    const fullYear = createdTime.getFullYear();
    const descDateStr = `${day}-${month}-${fullYear}`;
    const todayStr = this.formatDateDDMMYYYY(new Date());
    
    // Mover a obsoletos
    await this.moveFile(fileId, obsoletosFolderId);
    
    // Renombrar
    await this.renameFile(fileId, newName);
    
    // Actualizar descripción
    const currentDesc = metadata.description || "";
    const newDesc = currentDesc 
      ? `${currentDesc} | Obsoleto el ${todayStr}`
      : `Obsoleto el ${todayStr}`;
    await this.updateFileDescription(fileId, newDesc);
    
    logger.info("File moved to obsoletos", {
      fileId,
      originalName,
      newName,
      obsoletosFolderId,
    });
    
    return { fileId, newName, movedAt: todayStr };
  }

  // Formato DD-MM-YYYY
  formatDateDDMMYYYY(date) {
    const d = date instanceof Date ? date : new Date(date);
    const day = String(d.getDate()).padStart(2, "0");
    const month = String(d.getMonth() + 1).padStart(2, "0");
    const year = d.getFullYear();
    return `${day}-${month}-${year}`;
  }

  // Obtener carpeta padre principal desde config
  async getParentFolderId() {
    const db = await connect();
    const doc = await db.collection("config").findOne({ key: "driveParentFolder" });
    const parentFromDb = doc?.value;
    
    // Fallback a config.js si no hay en DB
    return parentFromDb || config.google.drive.parentFolderId;
  }

  // Asegurar árbol de carpetas para un certificado (optimizado)
  async ensureCertificateFolderTree(numCert) {
    const parentFolderId = await this.getParentFolderId();
    
    if (!parentFolderId) {
      throw new Error("No se configuró carpeta padre principal de Drive");
    }
    
    // Crear/obtener carpeta raíz del certificado
    const rootFolder = await this.ensureFolder(String(numCert), parentFolderId);
    
    // Crear subcarpetas principales en paralelo
    const [obseletosFolder, registrosFotograficosFolder] = await Promise.all([
      this.ensureFolder("Obsoletos", rootFolder.id),
      this.ensureFolder("Registros fotográficos", rootFolder.id),
    ]);
    
    // Las subcarpetas de secciones fotográficas se crean bajo demanda (lazy)
    // para no bloquear la creación del certificado
    // Se crearán cuando se suban fotos a cada sección
    
    return {
      rootFolderId: rootFolder.id,
      rootFolderLink: rootFolder.webViewLink,
      obsoletosFolderId: obseletosFolder.id,
      registrosFotograficosFolderId: registrosFotograficosFolder.id,
      // Las sectionFolders se crean on-demand
      sectionFolders: {},
    };
  }
  
  // Obtener o crear carpeta de sección fotográfica bajo demanda
  async ensurePhotoSectionFolder(registrosFotograficosFolderId, sectionName) {
    return this.ensureFolder(sectionName, registrosFotograficosFolderId);
  }

  // Generar nombre de archivo con prefijo
  generateFileName(prefix, empresa, numCert, serial, timestamp, extension = ".pdf") {
    const safeEmpresa = String(empresa || "").replace(/[^a-zA-Z0-9]/g, "_").toUpperCase();
    const safeSerial = String(serial || "").replace(/[^a-zA-Z0-9]/g, "_").toUpperCase();
    return `${prefix}_${safeEmpresa}_${numCert}_${safeSerial}_${timestamp}${extension}`;
  }

    
  extractFileIdFromLink(link) {
    if (!link || link === "#") return null;

    const s = String(link);

    
    let m = s.match(/\/d\/([a-zA-Z0-9_-]+)/);
    if (m?.[1]) return m[1];

    
    m = s.match(/[?&]id=([a-zA-Z0-9_-]+)/);
    if (m?.[1]) return m[1];

    
    m = s.match(/\/uc\?id=([a-zA-Z0-9_-]+)/);
    if (m?.[1]) return m[1];

    return null;
  }

  
  async downloadFileStream(fileId) {
    if (!fileId) throw new Error("fileId requerido");

    
    const info = await this.getFileInfo(fileId);
    const name = info?.name || fileId;

    
    const resp = await this.drive.files.get(
      { fileId, alt: "media", supportsAllDrives: true },
      { responseType: "stream" }
    );

    return { name, stream: resp.data };
  }

  
  async uploadFile({
    localPath,
    fileName,
    mimeType,
    appProperties = {},
    folderId,
    skipFolderValidation = false,
  }) {
    performanceMonitor.trackDriveOperation();

    
    const targetFolder = folderId || config.google.drive.parentFolderId;

    if (!targetFolder) {
      throw new Error(
        "No se configuró carpeta de destino: no llegó folderId y DRIVE_PARENT_FOLDER_ID está vacío",
      );
    }

    // Solo validar acceso si no se indica saltar (optimización para uploads múltiples)
    if (!skipFolderValidation) {
      await this.validateFolderAccess(targetFolder);
    }

    
    const media = { mimeType, body: fs.createReadStream(localPath) };

    return retryOperation(async () => {
      
      const response = await this.drive.files.create({
        requestBody: {
          name: fileName,
          parents: [targetFolder],
          mimeType,
          description: this.buildDescription(appProperties),
        },
        media,
        fields: "id, webViewLink, webContentLink",
        supportsAllDrives: true,
      });

      // Establecer permisos en background (no bloquea el upload)
      this.setPermissions(response.data.id).catch((err) => {
        logger.warn("Failed to set permissions", { fileId: response.data.id, error: err.message });
      });
      
      return response.data;
    });
  }

  
  async validateFolderAccess(folderId) {
    try {
      await this.getFileInfo(folderId);
    } catch (error) {
      throw new Error(
        "No hay acceso a la carpeta destino (revisa OAuth y el ID)",
      );
    }
  }

  
  buildDescription(appProperties) {
    return [
      `Usuario(s): ${appProperties.Usuario || ""}`,
      `NumCert: ${appProperties.NumCert || ""}`,
      `Serial: ${appProperties.Serial || ""}`,
    ].join(" | ");
  }

  
  async setPermissions(fileId) {
    const { share } = config.google.drive;
    const perm = { type: share.type, role: share.role };

    
    if (share.type === "domain" && share.domain) {
      perm.domain = share.domain;
    }

    
    await this.drive.permissions.create({
      fileId,
      requestBody: perm,
    });
  }

  
  // LEGACY: Método anterior para compatibilidad con flujos existentes
  async uploadCertificateFilesLegacy(files, meta, empresa, numCert, serial) {
    const timestamp = Date.now();
    const results = {};
    
    const dbFolders = await this.getDriveFolders();
    const parent = config.google.drive.parentFolderId;

    const folderConfigs = [
      { fileKey: "informes", type: "INF", folderKey: "INF" },
      { fileKey: "formatos", type: "FOR", folderKey: "FOR" },
      { fileKey: "certificados", type: "CERT", folderKey: "CERT" },
    ];

    const uploadPromises = folderConfigs.map(async ({ fileKey, type, folderKey }) => {
      const file = pickFirst(files[fileKey]);
      if (!file) return;

      const folder = dbFolders[folderKey] || config.google.drive.folders[folderKey] || parent;
      
      try {
        const result = await this.uploadFile({
          localPath: file.path,
          fileName: `${empresa}_${numCert}_${serial}_${timestamp}${this.getFileExtension(file.originalname)}`,
          mimeType: file.mimetype || "application/pdf",
          appProperties: meta,
          folderId: folder,
        });
        results[type.toLowerCase()] = result.webViewLink;
      } catch (error) {
        logger.error(`Failed to upload ${type} file`, error);
        throw error;
      }
    });

    await Promise.all(uploadPromises);

    return {
      informes: results.inf,
      formatos: results.for,
      certificados: results.cert,
    };
  }

  // Nuevo flujo: Subir archivos de certificado al árbol de carpetas por numCert (optimizado)
  async uploadCertificateFiles(files, meta, empresa, numCert, serial, existingStorage = null) {
    const timestamp = Date.now();
    const results = {
      informes: null,
      certificados: null,
      anexos: null,
      formatos: null,
      driveFolder: null,
    };
    
    // Asegurar árbol de carpetas
    let storage = existingStorage;
    if (!storage?.rootFolderId) {
      storage = await this.ensureCertificateFolderTree(numCert);
    }
    
    const rootFolderId = storage.rootFolderId;
    results.driveFolder = storage.rootFolderLink || `https://drive.google.com/drive/folders/${rootFolderId}`;

    // Configuración de archivos a subir
    const fileConfigs = [
      { fileKey: "informes", prefix: "INF", resultKey: "informes" },
      { fileKey: "formatos", prefix: "FOR", resultKey: "formatos" },
      { fileKey: "certificados", prefix: "CERT", resultKey: "certificados" },
      { fileKey: "anexos", prefix: "ANEXOS", resultKey: "anexos" },
    ];

    // Preparar uploads en paralelo
    const uploadPromises = [];
    
    for (const { fileKey, prefix, resultKey } of fileConfigs) {
      const file = pickFirst(files[fileKey]);
      if (!file) continue;

      const ext = this.getFileExtension(file.originalname);
      const fileName = this.generateFileName(prefix, empresa, numCert, serial, timestamp, ext);
      
      // Crear promesa de upload (skipFolderValidation porque ya validamos al crear árbol)
      const uploadPromise = this.uploadFile({
        localPath: file.path,
        fileName,
        mimeType: file.mimetype || "application/pdf",
        appProperties: meta,
        folderId: rootFolderId,
        skipFolderValidation: true,
      }).then((result) => {
        results[resultKey] = result.webViewLink;
        logger.info(`Uploaded ${prefix} file`, { fileName, link: result.webViewLink });
        return { resultKey, success: true };
      }).catch((error) => {
        logger.error(`Failed to upload ${prefix} file`, error);
        throw error;
      });
      
      uploadPromises.push(uploadPromise);
    }

    // Ejecutar todos los uploads en paralelo
    if (uploadPromises.length > 0) {
      await Promise.all(uploadPromises);
    }

    // Retornar también storage para persistencia
    results._storage = storage;
    
    return results;
  }

  // Reemplazar archivo existente (mover antiguo a obsoletos)
  async replaceFile(existingLink, newFile, prefix, empresa, numCert, serial, storage) {
    const timestamp = Date.now();
    
    // Mover archivo existente a obsoletos si hay link válido
    if (existingLink && existingLink !== "#") {
      const existingFileId = this.extractFileIdFromLink(existingLink);
      if (existingFileId && storage?.obsoletosFolderId) {
        try {
          await this.moveToObsoletos(existingFileId, storage.obsoletosFolderId);
        } catch (error) {
          logger.warn("Could not move old file to obsoletos", {
            fileId: existingFileId,
            error: error.message,
          });
          // Continuar aunque falle el movimiento a obsoletos
        }
      }
    }
    
    // Subir nuevo archivo
    const ext = this.getFileExtension(newFile.originalname);
    const fileName = this.generateFileName(prefix, empresa, numCert, serial, timestamp, ext);
    
    const result = await this.uploadFile({
      localPath: newFile.path,
      fileName,
      mimeType: newFile.mimetype || "application/pdf",
      appProperties: {
        NumCert: String(numCert),
        Serial: String(serial),
      },
      folderId: storage.rootFolderId,
    });
    
    logger.info(`Replaced ${prefix} file`, { fileName, link: result.webViewLink });
    
    return result.webViewLink;
  }

  // Subir foto a carpeta de sección específica
  async uploadPhotoToSection(photoFile, sectionName, storage) {
    const sectionFolderId = storage.sectionFolders?.[sectionName];
    if (!sectionFolderId) {
      logger.warn("Section folder not found", { sectionName });
      return null;
    }
    
    const timestamp = Date.now();
    const ext = this.getFileExtension(photoFile.originalname || ".jpg");
    const fileName = `foto_${timestamp}${ext}`;
    
    const result = await this.uploadFile({
      localPath: photoFile.path,
      fileName,
      mimeType: photoFile.mimetype || "image/jpeg",
      appProperties: {},
      folderId: sectionFolderId,
    });
    
    return result.webViewLink;
  }

  async downloadUrlToFile(url, token, outputPath, maxRedirects = 5) {
    let currentUrl = url;
    let redirectCount = 0;

    while (redirectCount < maxRedirects) {
      const result = await new Promise((resolve, reject) => {
        const fileStream = fs.createWriteStream(outputPath);

        const req = https.get(
          currentUrl,
          {
            headers: {
              Authorization: `Bearer ${token}`,
            },
          },
          (res) => {
            // Handle redirects (301, 302, 303, 307, 308)
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
              fileStream.close();
              fs.unlink(outputPath, () => {});
              resolve({ redirect: res.headers.location });
              return;
            }

            if (res.statusCode !== 200) {
              fileStream.close();
              fs.unlink(outputPath, () => {});
              reject(new Error(`Error exportando PDF: HTTP ${res.statusCode}`));
              return;
            }

            res.pipe(fileStream);
            fileStream.on("finish", () => fileStream.close(() => resolve({ done: true })));
          },
        );

        req.on("error", (error) => {
          fileStream.close();
          fs.unlink(outputPath, () => {});
          reject(error);
        });

        fileStream.on("error", (error) => {
          req.destroy(error);
        });
      });

      if (result.done) {
        return;
      }

      if (result.redirect) {
        currentUrl = result.redirect;
        redirectCount++;
        logger.info("PDF export redirect", { redirectCount, newUrl: currentUrl.slice(0, 100) });
        continue;
      }
    }

    throw new Error(`Demasiados redirects al exportar PDF (${maxRedirects})`);
  }

  async convertExcelToPdf(excelPath, outputPdfPath) {
    const maxAttempts = 3;
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    let lastError = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      let tempSheetId = null;

      try {
        logger.info("PDF conversion attempt started", { attempt, maxAttempts });

        const uploaded = await this.drive.files.create({
          requestBody: {
            name: `tmp_pdf_${Date.now()}`,
            mimeType: "application/vnd.google-apps.spreadsheet",
          },
          media: {
            mimeType:
              "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            body: fs.createReadStream(excelPath),
          },
          fields: "id",
          supportsAllDrives: true,
        });

        tempSheetId = uploaded.data?.id;
        if (!tempSheetId) throw new Error("No se pudo crear hoja temporal para PDF");

        const tokenData = await this.oauth2.getAccessToken();
        const token = typeof tokenData === "string" ? tokenData : tokenData?.token;

        if (!token) throw new Error("No se pudo obtener token OAuth para exportar PDF");

        // PDF export params:
        // size=0 = Letter, scale=4 = Fit to page (width & height)
        // horizontal=true = center horizontally
        // margins in inches (0.15 = minimal)
        const pdfExportUrl =
          `https://docs.google.com/spreadsheets/d/${tempSheetId}/export` +
          "?format=pdf" +
          "&size=0" +
          "&portrait=true" +
          "&scale=4" +
          "&horizontal_alignment=CENTER" +
          "&top_margin=0.15" +
          "&bottom_margin=0.15" +
          "&left_margin=0.15" +
          "&right_margin=0.15" +
          "&sheetnames=false" +
          "&printtitle=false" +
          "&pagenum=UNDEFINED" +
          "&gridlines=false" +
          "&fzr=false";

        await wait(800);
        await this.downloadUrlToFile(pdfExportUrl, token, outputPdfPath);
        logger.info("PDF conversion completed", { attempt });
        return;
      } catch (error) {
        lastError = error;
        logger.warn("PDF conversion attempt failed", {
          attempt,
          maxAttempts,
          error: error.message,
        });

        if (attempt < maxAttempts) {
          await wait(1500 * attempt);
        }
      } finally {
        if (tempSheetId) {
          try {
            await this.drive.files.delete({
              fileId: tempSheetId,
              supportsAllDrives: true,
            });
          } catch (error) {
            logger.warn("No se pudo eliminar hoja temporal de PDF", {
              fileId: tempSheetId,
              error: error.message,
            });
          }
        }
      }
    }

    throw lastError || new Error("No se pudo convertir Excel a PDF");
  }

  
  getFileExtension(filename) {
    if (!filename) return ".pdf";
    const ext = filename.substring(filename.lastIndexOf("."));
    return ext || ".pdf";
  }
}


export const driveService = new DriveService();
