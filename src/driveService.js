// Servicio de integración con Google Drive
// Maneja autenticación OAuth, subida, descarga y gestión de archivos en Google Drive
import { google } from "googleapis";
import fs from "fs";
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
  }) {
    performanceMonitor.trackDriveOperation();

    
    const targetFolder = folderId || config.google.drive.parentFolderId;

    if (!targetFolder) {
      throw new Error(
        "No se configuró carpeta de destino: no llegó folderId y DRIVE_PARENT_FOLDER_ID está vacío",
      );
    }

    
    await this.validateFolderAccess(targetFolder);

    
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

      
      await this.setPermissions(response.data.id);
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

  
  async uploadCertificateFiles(files, meta, empresa, numCert, serial) {
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

  
  getFileExtension(filename) {
    if (!filename) return ".pdf";
    const ext = filename.substring(filename.lastIndexOf("."));
    return ext || ".pdf";
  }
}


export const driveService = new DriveService();
