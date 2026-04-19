// Google Drive integration service.
// Handles OAuth authentication plus file and folder operations.
import { google } from "googleapis";
import fs from "fs";
import https from "https";
import { Readable } from "stream";
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

  // Initialize OAuth2 client and warm up token access.
  initializeAuth() {
    // Build OAuth2 client from configured credentials.
    this.oauth2 = new google.auth.OAuth2(
      config.google.oauth.clientId,
      config.google.oauth.clientSecret,
    );
    // Use refresh token so access tokens are rotated automatically.
    this.oauth2.setCredentials({
      refresh_token: config.google.oauth.refreshToken,
    });

    
    // Create Drive API v3 client.
    this.drive = google.drive({ version: "v3", auth: this.oauth2 });

    
    // Trigger a lightweight token request to fail fast on bad credentials.
    this.warmUpAuth();
  }

  
  // Verifies OAuth credentials during service startup.
  async warmUpAuth() {
    try {
      await this.oauth2.getAccessToken();
      logger.info("Google OAuth warm-up successful");
    } catch (error) {
      logger.warn("Google OAuth warm-up failed", { error: error.message });
    }
  }

  
  // Cache Drive folder config to reduce database reads.
  driveFoldersCache = null;
  driveFoldersCacheUntil = 0;
  
  // Cache discovered/created folders to avoid repeated Drive lookups.
  // Key format: "parentId:folderName".
  folderCache = new Map();
  FOLDER_CACHE_TTL = 10 * 60 * 1000; // 10 minutes.

  
  // Load folder configuration from MongoDB with a short TTL cache.
  async getDriveFolders() {
    const now = Date.now();

    
    // Reuse cached value while still valid (1 minute).
    if (this.driveFoldersCache && now < this.driveFoldersCacheUntil) {
      return this.driveFoldersCache;
    }

    try {
      const db = await connect();

      // Read driveFolders from the config collection.
      const doc = await db
        .collection("config")
        .findOne({ key: "driveFolders" }, { projection: { _id: 0, value: 1 } });

      const folders = doc?.value || {};

      // Refresh cache window.
      this.driveFoldersCache = folders;
      this.driveFoldersCacheUntil = now + 60_000; // 1 minute cache TTL.

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

  // Retrieve extended metadata used by archival flows.
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

  // Download a Drive file as a data URI (useful for embedding images in PDFs).
  async getFileDataUri(fileId, fallbackMimeType = "image/jpeg") {
    return retryOperation(async () => {
      const response = await this.drive.files.get(
        {
          fileId,
          alt: "media",
          supportsAllDrives: true,
        },
        {
          responseType: "arraybuffer",
        },
      );

      const buffer = Buffer.from(response.data || []);
      if (!buffer.length) return null;

      const mimeType =
        response.headers?.["content-type"] || fallbackMimeType || "image/jpeg";
      return `data:${mimeType};base64,${buffer.toString("base64")}`;
    });
  }

  // Create a folder and apply sharing permissions.
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
      
      // Keep folder ACLs aligned with configured sharing policy.
      await this.setPermissions(response.data.id);
      
      return response.data;
    });
  }

  // Find a child folder by name under a parent folder.
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

  // Return an existing folder or create it, with cache short-circuiting.
  async ensureFolder(name, parentFolderId) {
    const cacheKey = `${parentFolderId}:${name}`;
    const now = Date.now();
    
    // Check local cache first.
    const cached = this.folderCache.get(cacheKey);
    if (cached && (now - cached.cachedAt) < this.FOLDER_CACHE_TTL) {
      return { id: cached.id, name: cached.name, webViewLink: cached.webViewLink };
    }
    
    // Fallback to Drive search.
    const existing = await this.findFolderByName(name, parentFolderId);
    if (existing) {
      // Cache positive lookup.
      this.folderCache.set(cacheKey, { ...existing, cachedAt: now });
      return existing;
    }
    
    // Create when not found.
    const created = await this.createFolder(name, parentFolderId);
    // Cache created folder metadata.
    this.folderCache.set(cacheKey, { ...created, cachedAt: now });
    return created;
  }
  
  // Clear cached folder references after structural Drive changes.
  clearFolderCache() {
    this.folderCache.clear();
  }

  // Move a file to a new parent folder.
  async moveFile(fileId, newParentFolderId, removeFromCurrentParent = true) {
    performanceMonitor.trackDriveOperation();
    
    return retryOperation(async () => {
      // Read current parents to support optional removeParents.
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

  // Rename a Drive file.
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

  // Update file description metadata.
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

  // Archive a file into Obsoletos with traceable name and description.
  async moveToObsoletos(fileId, obsoletosFolderId) {
    // Read source metadata before modifying file state.
    const metadata = await this.getFileMetadata(fileId);
    const originalName = metadata.name || "archivo";
    const createdTime = metadata.createdTime ? new Date(metadata.createdTime) : new Date();
    
    // Build short date suffix: DD-MM-YY.
    const day = String(createdTime.getDate()).padStart(2, "0");
    const month = String(createdTime.getMonth() + 1).padStart(2, "0");
    const year = String(createdTime.getFullYear()).slice(-2);
    const dateStr = `${day}-${month}-${year}`;
    
    // Rename format: "<name> (DD-MM-YY).ext".
    const extMatch = originalName.match(/(\.[^.]+)$/);
    const ext = extMatch ? extMatch[1] : "";
    const nameWithoutExt = ext ? originalName.slice(0, -ext.length) : originalName;
    const newName = `${nameWithoutExt} (${dateStr})${ext}`;
    
    // Build full date for description trail.
    const fullYear = createdTime.getFullYear();
    const descDateStr = `${day}-${month}-${fullYear}`;
    const todayStr = this.formatDateDDMMYYYY(new Date());
    
    // Move file to obsolete folder first.
    await this.moveFile(fileId, obsoletosFolderId);
    
    // Then rename to preserve original chronology.
    await this.renameFile(fileId, newName);
    
    // Append archival marker to description.
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

  // Formats dates as DD-MM-YYYY for user-facing metadata.
  formatDateDDMMYYYY(date) {
    const d = date instanceof Date ? date : new Date(date);
    const day = String(d.getDate()).padStart(2, "0");
    const month = String(d.getMonth() + 1).padStart(2, "0");
    const year = d.getFullYear();
    return `${day}-${month}-${year}`;
  }

  // Resolve root Drive folder from DB config with env fallback.
  async getParentFolderId() {
    const db = await connect();
    const doc = await db.collection("config").findOne({ key: "driveParentFolder" });
    const parentFromDb = doc?.value;
    
    // Fallback to static config when DB value is missing.
    return parentFromDb || config.google.drive.parentFolderId;
  }

  // Ensure the root folder tree exists for a certificate.
  async ensureCertificateFolderTree(numCert) {
    const parentFolderId = await this.getParentFolderId();
    
    if (!parentFolderId) {
      throw new Error("No se configuró carpeta padre principal de Drive");
    }
    
    // Create or reuse certificate root folder.
    const rootFolder = await this.ensureFolder(String(numCert), parentFolderId);
    
    // Create mandatory child folders in parallel.
    const [obseletosFolder, registrosFotograficosFolder] = await Promise.all([
      this.ensureFolder("Obsoletos", rootFolder.id),
      this.ensureFolder("Registros fotográficos", rootFolder.id),
    ]);
    
    // Section folders are created lazily when photos are uploaded.
    
    return {
      rootFolderId: rootFolder.id,
      rootFolderLink: rootFolder.webViewLink,
      obsoletosFolderId: obseletosFolder.id,
      registrosFotograficosFolderId: registrosFotograficosFolder.id,
      // Section folder IDs are populated on demand.
      sectionFolders: {},
    };
  }
  
  // Ensure folder for one photo section.
  async ensurePhotoSectionFolder(registrosFotograficosFolderId, sectionName) {
    return this.ensureFolder(sectionName, registrosFotograficosFolderId);
  }

  // Build deterministic upload names for traceability.
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

  // Stable thumbnail URL (avoids expiring Drive API thumbnailLink tokens).
  getThumbnailUrl(fileId, size = "w1200") {
    const safeId = String(fileId || "").trim();
    if (!safeId) return null;
    return `https://drive.google.com/thumbnail?id=${encodeURIComponent(safeId)}&sz=${encodeURIComponent(size)}`;
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

  // Skip revalidation when folder access was already verified for the batch.
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
        fields: "id, webViewLink, webContentLink, thumbnailLink",
        supportsAllDrives: true,
      });

      // Apply permissions asynchronously to keep uploads responsive.
      this.setPermissions(response.data.id).catch((err) => {
        logger.warn("Failed to set permissions", { fileId: response.data.id, error: err.message });
      });
      
      return response.data;
    });
  }

  // Upload an in-memory Buffer directly to Drive without a local temp file.
  async uploadBufferFile({ buffer, fileName, mimeType, folderId, appProperties = {} }) {
    performanceMonitor.trackDriveOperation();

    const targetFolder = folderId || config.google.drive.parentFolderId;
    if (!targetFolder) {
      throw new Error(
        "No se configuró carpeta de destino: no llegó folderId y DRIVE_PARENT_FOLDER_ID está vacío",
      );
    }

    await this.validateFolderAccess(targetFolder);

    const stream = Readable.from(buffer);
    const media = { mimeType, body: stream };

    return retryOperation(async () => {
      const response = await this.drive.files.create({
        requestBody: {
          name: fileName,
          parents: [targetFolder],
          mimeType,
          description: this.buildDescription(appProperties),
        },
        media,
        fields: "id, webViewLink, webContentLink, thumbnailLink",
        supportsAllDrives: true,
      });

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

  
  // Legacy upload flow kept for backward compatibility.
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

  // Preferred upload flow: store all certificate files under its folder tree.
  async uploadCertificateFiles(files, meta, empresa, numCert, serial, existingStorage = null) {
    const timestamp = Date.now();
    const results = {
      informes: null,
      certificados: null,
      anexos: null,
      formatos: null,
      driveFolder: null,
    };
    
    // Ensure storage structure is available.
    let storage = existingStorage;
    if (!storage?.rootFolderId) {
      storage = await this.ensureCertificateFolderTree(numCert);
    }
    
    const rootFolderId = storage.rootFolderId;
    results.driveFolder = storage.rootFolderLink || `https://drive.google.com/drive/folders/${rootFolderId}`;

    // Expected upload slots.
    const fileConfigs = [
      { fileKey: "informes", prefix: "INF", resultKey: "informes" },
      { fileKey: "formatos", prefix: "FOR", resultKey: "formatos" },
      { fileKey: "certificados", prefix: "CERT", resultKey: "certificados" },
      { fileKey: "anexos", prefix: "ANEXOS", resultKey: "anexos" },
    ];

    // Build parallel uploads.
    const uploadPromises = [];
    
    for (const { fileKey, prefix, resultKey } of fileConfigs) {
      const file = pickFirst(files[fileKey]);
      if (!file) continue;

      const ext = this.getFileExtension(file.originalname);
      const fileName = this.generateFileName(prefix, empresa, numCert, serial, timestamp, ext);
      
      // Skip folder validation because tree creation already checked access.
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

    // Execute all uploads concurrently.
    if (uploadPromises.length > 0) {
      await Promise.all(uploadPromises);
    }

    // Return storage metadata so callers can persist folder references.
    results._storage = storage;
    
    return results;
  }

  // Replace an existing file and archive the old version when possible.
  async replaceFile(existingLink, newFile, prefix, empresa, numCert, serial, storage) {
    const timestamp = Date.now();
    
    // Archive previous file if a valid link is present.
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
          // Replacement should continue even if archival fails.
        }
      }
    }
    
    // Upload replacement file.
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

  // Upload a photo into a specific section folder.
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

  /**
   * Eliminar un archivo de Google Drive
   * @param {string} fileId - ID del archivo a eliminar
   * @returns {Promise<boolean>} - true si se eliminó correctamente
   */
  async deleteFile(fileId) {
    if (!fileId) {
      logger.warn("deleteFile called without fileId");
      return false;
    }

    performanceMonitor.trackDriveOperation();

    return retryOperation(async () => {
      try {
        await this.drive.files.delete({
          fileId,
          supportsAllDrives: true,
        });
        logger.info("File deleted from Drive", { fileId });
        return true;
      } catch (error) {
        // Si el archivo no existe (404), considerarlo como éxito
        if (error.code === 404) {
          logger.info("File already deleted or not found", { fileId });
          return true;
        }
        throw error;
      }
    });
  }
}


export const driveService = new DriveService();
