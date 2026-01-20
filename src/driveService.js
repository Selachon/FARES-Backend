import { google } from "googleapis";
import fs from "fs";
import { config } from "./config.js";
import { logger, retryOperation, pickFirst } from "./utils.js";
import { performanceMonitor } from "./performanceMonitor.js";

// Servicio centralizado para operaciones con Google Drive
class DriveService {
  constructor() {
    this.oauth2 = null;  // Cliente OAuth2 de Google
    this.drive = null;    // Cliente de Google Drive
    this.initializeAuth(); // Inicializa autenticación al crear instancia
  }

  // Inicializa la autenticación OAuth2 con Google APIs
  initializeAuth() {
    // Crea cliente OAuth2 con credenciales desde configuración
    this.oauth2 = new google.auth.OAuth2(
      config.google.oauth.clientId,      // ID de cliente OAuth2
      config.google.oauth.clientSecret   // Secreto de cliente OAuth2
    );
    
    // Establece credenciales usando refresh token (para acceso persistente)
    this.oauth2.setCredentials({
      refresh_token: config.google.oauth.refreshToken,
    });

    // Crea cliente de Drive API con autenticación
    this.drive = google.drive({ version: "v3", auth: this.oauth2 });
    
    // Realiza conexión inicial para detectar problemas temprano
    this.warmUpAuth();
  }

  // Realiza conexión inicial para verificar credenciales y refrescar token
  async warmUpAuth() {
    try {
      await this.oauth2.getAccessToken(); // Fuerza refresco de access token
      logger.info("Google OAuth warm-up successful");
    } catch (error) {
      logger.warn("Google OAuth warm-up failed", { error: error.message });
    }
  }

  // Obtiene información de un archivo en Drive
  async getFileInfo(fileId) {
    return retryOperation(async () => {
      const response = await this.drive.files.get({
        fileId,
        fields: "id,name,parents,mimeType,driveId", // Campos específicos solicitados
        supportsAllDrives: true, // Soporta Shared Drives
      });
      return response.data;
    });
  }

  // Sube archivo a Google Drive con metadatos y permisos
  async uploadFile({ localPath, fileName, mimeType, appProperties = {}, folderId }) {
    performanceMonitor.trackDriveOperation(); // Registra operación para métricas
    
    // Determina carpeta destino: específica o por defecto
    const targetFolder = folderId || config.google.drive.parentFolderId;
    
    if (!targetFolder) {
      throw new Error("No se configuró carpeta de destino");
    }

    // Verifica que tengamos acceso a la carpeta destino
    await this.validateFolderAccess(targetFolder);

    // Prepara media stream para subida eficiente
    const media = { mimeType, body: fs.createReadStream(localPath) };
    
    return retryOperation(async () => {
      // Crea archivo en Drive con metadatos
      const response = await this.drive.files.create({
        requestBody: {
          name: fileName,                                    // Nombre del archivo
          parents: [targetFolder],                           // Carpeta destino
          mimeType,                                          // Tipo MIME
          description: this.buildDescription(appProperties),  // Descripción con metadatos
        },
        media,                                               // Stream del archivo
        fields: "id, webViewLink, webContentLink",            // Campos a retornar
        supportsAllDrives: true,                             // Soporta Shared Drives
      });

      // Configura permisos de compartición del archivo
      await this.setPermissions(response.data.id);
      return response.data;
    });
  }

  // Verifica que la carpeta destino exista y sea accesible
  async validateFolderAccess(folderId) {
    try {
      await this.getFileInfo(folderId); // Intenta obtener info de la carpeta
    } catch (error) {
      throw new Error("No hay acceso a la carpeta destino (revisa OAuth y el ID)");
    }
  }

  // Construye descripción del archivo con metadatos del certificado
  buildDescription(appProperties) {
    return [
      `Usuario(s): ${appProperties.Usuario || ""}`,
      `NumCert: ${appProperties.NumCert || ""}`,
      `Serial: ${appProperties.Serial || ""}`,
    ].join(" | ");
  }

  // Configura permisos de compartición para archivos subidos
  async setPermissions(fileId) {
    const { share } = config.google.drive;
    const perm = { type: share.type, role: share.role };
    
    // Si es compartición por dominio, especifica el dominio
    if (share.type === "domain" && share.domain) {
      perm.domain = share.domain;
    }

    // Crea permisos para que el archivo sea accesible
    await this.drive.permissions.create({ 
      fileId, 
      requestBody: perm 
    });
  }

  // Sube los tres tipos de archivos de un certificado en paralelo
  async uploadCertificateFiles(files, meta, empresa, numCert, serial) {
    const timestamp = Date.now(); // Timestamp único para todos los archivos
    const results = {};
    
    // Define los tres tipos de archivos a procesar
    const uploadPromises = [
      { file: pickFirst(files.informes), type: "INF", folder: config.google.drive.folders.INF },
      { file: pickFirst(files.formatos), type: "FOR", folder: config.google.drive.folders.FOR },
      { file: pickFirst(files.certificados), type: "CERT", folder: config.google.drive.folders.CERT }
    ];

    // Procesa todas las subidas en paralelo para mejor rendimiento
    await Promise.allSettled(uploadPromises.map(async ({ file, type, folder }) => {
      if (file) {
        try {
          const result = await this.uploadFile({
            localPath: file.path,
            fileName: `${empresa}_${numCert}_${serial}_${timestamp}${this.getFileExtension(file.originalname)}`,
            mimeType: file.mimetype || "application/pdf",
            appProperties: meta,
            folderId: folder
          });
          results[type.toLowerCase()] = result.webViewLink;
        } catch (error) {
          logger.error(`Failed to upload ${type} file`, error);
          throw error;
        }
      }
    }));

    // Retorna objeto con los enlaces de todos los archivos
    return {
      informes: results.inf || "#",
      formatos: results.for || "#",
      certificados: results.cert || "#"
    };
  }

  // Obtiene extensión de archivo, por defecto .pdf
  getFileExtension(filename) {
    if (!filename) return ".pdf";
    const ext = filename.substring(filename.lastIndexOf("."));
    return ext || ".pdf";
  }
}

// Exporta instancia única del servicio (singleton)
export const driveService = new DriveService();

export const driveService = new DriveService();