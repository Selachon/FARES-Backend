// Servicio de gestión de configuración del sistema
// Maneja configuraciones dinámicas almacenadas en base de datos
import { connect } from "./db.js";
import { logger, createError, sanitizeString } from "./utils.js";
import { cacheService } from "./cacheService.js";
import { performanceMonitor } from "./performanceMonitor.js";

class ConfigService {
  constructor() {
    this.collectionName = "config";
  }

  // Obtener carpeta padre principal de Drive
  async getDriveParentFolder() {
    try {
      performanceMonitor.trackDbQuery();
      return await cacheService.getOrSet(
        "drive_parent_folder",
        async () => {
          const db = await connect();
          const doc = await db.collection(this.collectionName).findOne({
            key: "driveParentFolder"
          });
          return doc?.value || "";
        },
        15 * 60 * 1000
      );
    } catch (error) {
      logger.error("Failed to get drive parent folder", error);
      throw createError("Error obteniendo carpeta principal", 500);
    }
  }

  // Actualizar carpeta padre principal de Drive
  async updateDriveParentFolder(folderId) {
    try {
      if (!folderId || typeof folderId !== "string") {
        throw createError("folderId requerido", 400);
      }

      performanceMonitor.trackDbQuery();
      const db = await connect();

      const sanitizedId = sanitizeString(folderId);

      await db.collection(this.collectionName).updateOne(
        { key: "driveParentFolder" },
        {
          $set: {
            key: "driveParentFolder",
            value: sanitizedId,
            updatedAt: new Date()
          }
        },
        { upsert: true }
      );

      cacheService.clear("drive_parent_folder");
      logger.info("Drive parent folder updated", { folderId: sanitizedId });
      return { PARENT: sanitizedId };
    } catch (error) {
      if (error.statusCode) throw error;
      logger.error("Failed to update drive parent folder", error);
      throw createError("Fallo guardando carpeta principal", 500);
    }
  }
  
  // LEGACY: Obtener configuración de carpetas de Drive con caché (compatibilidad)
  async getDriveFolders() {
    try {
      performanceMonitor.trackDbQuery();
      // Usar caché para optimizar rendimiento
      return await cacheService.getOrSet(
        "drive_folders_config",
        async () => {
          const db = await connect();
          
          // Primero intentar obtener la nueva config PARENT
          const parentDoc = await db.collection(this.collectionName).findOne({
            key: "driveParentFolder"
          });
          
          // Luego obtener config legacy
          const legacyDoc = await db.collection(this.collectionName).findOne({ 
            key: "driveFolders" 
          });
          
          // Valores por defecto si no hay configuración
          const folders = legacyDoc?.value || {
            INF: "",  // Informes
            FOR: "",  // Formatos
            CERT: ""  // Certificados
          };

          // Agregar PARENT si existe
          if (parentDoc?.value) {
            folders.PARENT = parentDoc.value;
          }

          return folders;
        },
        15 * 60 * 1000  // 15 minutos de caché
      );
    } catch (error) {
      logger.error("Failed to get drive folders", error);
      throw createError("Error obteniendo carpetas", 500);
    }
  }

  // LEGACY: Actualizar carpetas (compatibilidad + nuevo PARENT)
  async updateDriveFolders(folderUpdates) {
    try {
      const { INF, FOR, CERT, PARENT } = folderUpdates || {};
      
      // Si viene PARENT, usamos el nuevo método
      if (PARENT !== undefined) {
        await this.updateDriveParentFolder(PARENT);
      }
      
      // Si no hay campos legacy, solo retornamos
      if (INF === undefined && FOR === undefined && CERT === undefined) {
        if (PARENT !== undefined) {
          // Ya actualizamos PARENT arriba
          const parentFolder = await this.getDriveParentFolder();
          return { PARENT: parentFolder };
        }
        throw createError("No hay campos para actualizar", 400);
      }

      performanceMonitor.trackDbQuery();
      const db = await connect();
      
      const currentDoc = await db.collection(this.collectionName).findOne(
        { key: "driveFolders" },
        { projection: { _id: 0, value: 1 } }
      );
      
      const current = currentDoc?.value || { INF: "", FOR: "", CERT: "" };

      const merged = {
        INF: typeof INF === "string" ? sanitizeString(INF) : current.INF,
        FOR: typeof FOR === "string" ? sanitizeString(FOR) : current.FOR,
        CERT: typeof CERT === "string" ? sanitizeString(CERT) : current.CERT,
      };

      await db.collection(this.collectionName).updateOne(
        { key: "driveFolders" },
        { 
          $set: { 
            key: "driveFolders", 
            value: merged, 
            updatedAt: new Date() 
          } 
        },
        { upsert: true }
      );

      cacheService.clear("drive_folders_config");
      logger.info("Drive folders updated", merged);
      
      // Incluir PARENT en respuesta si existe
      const parentFolder = await this.getDriveParentFolder();
      if (parentFolder) {
        merged.PARENT = parentFolder;
      }
      
      return merged;
    } catch (error) {
      if (error.statusCode) throw error;
      
      logger.error("Failed to update drive folders", error);
      throw createError("Fallo guardando carpetas", 500);
    }
  }

  
  async getDriveFileInfo(fileId) {
    try {
      
      if (!fileId) {
        throw createError("Falta id", 400);
      }

      
      const { driveService } = await import("./driveService.js");
      
      
      const info = await driveService.getFileInfo(fileId);
      
      return info;
    } catch (error) {
      
      if (error.statusCode) throw error;
      
      logger.error("Failed to get drive file info", error);
      throw createError("No se encontró la carpeta", 404);
    }
  }
}


export const configService = new ConfigService();