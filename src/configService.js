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
  
  // Obtener configuración de carpetas de Drive con caché
  async getDriveFolders() {
    try {
      performanceMonitor.trackDbQuery();
      // Usar caché para optimizar rendimiento
      return await cacheService.getOrSet(
        "drive_folders_config",
        async () => {
          const db = await connect();
          const doc = await db.collection(this.collectionName).findOne({ 
            key: "driveFolders" 
          });
          
          
          // Valores por defecto si no hay configuración
          const folders = doc?.value || {
            INF: "",  // Informes
            FOR: "",  // Formatos
            CERT: ""  // Certificados
          };

          return folders;
        },
        15 * 60 * 1000  // 15 minutos de caché
      );
    } catch (error) {
      logger.error("Failed to get drive folders", error);
      throw createError("Error obteniendo carpetas", 500);
    }
  }

  
  async updateDriveFolders(folderUpdates) {
    try {
      const { INF, FOR, CERT } = folderUpdates || {};
      
      if (INF === undefined && FOR === undefined && CERT === undefined) {
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