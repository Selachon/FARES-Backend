import { connect } from "./db.js";
import { logger, createError, sanitizeString } from "./utils.js";
import { cacheService } from "./cacheService.js";
import { performanceMonitor } from "./performanceMonitor.js";

// Servicio para gestión de configuración dinámica del sistema
class ConfigService {
  constructor() {
    this.collectionName = "config"; // Nombre de colección en MongoDB
  }

  // Obtiene configuración de carpetas de Drive (con caché)
  async getDriveFolders() {
    try {
      performanceMonitor.trackDbQuery();
      
      // Usa caché para reducir carga en base de datos
      // La configuración de carpetas cambia con poca frecuencia
      return await cacheService.getOrSet(
        "drive_folders_config",
        async () => {
          const db = await connect();
          const doc = await db.collection(this.collectionName).findOne({ 
            key: "driveFolders" 
          });
          
          // Valores por defecto si no existe configuración
          const folders = doc?.value || {
            INF: "", // Carpeta para informes
            FOR: "", // Carpeta para formatos  
            CERT: "" // Carpeta para certificados
          };

          return folders;
        },
        15 * 60 * 1000 // Cache por 15 minutos (configuración es estable)
      );
    } catch (error) {
      logger.error("Failed to get drive folders", error);
      throw createError("Error obteniendo carpetas", 500);
    }
  }

  // Actualiza configuración de carpetas de Drive (con validación y caché)
  async updateDriveFolders(folderUpdates) {
    try {
      const { INF, FOR, CERT } = folderUpdates || {};
      
      // Valida que al menos un campo se esté actualizando
      if (INF === undefined && FOR === undefined && CERT === undefined) {
        throw createError("No hay campos para actualizar", 400);
      }

      performanceMonitor.trackDbQuery();
      const db = await connect();
      
      // Obtiene configuración actual (solo el valor, sin _id)
      const currentDoc = await db.collection(this.collectionName).findOne(
        { key: "driveFolders" },
        { projection: { _id: 0, value: 1 } }
      );
      
      // Valores actuales o por defecto si no existen
      const current = currentDoc?.value || {
        INF: "",
        FOR: "",
        CERT: ""
      };

      // Fusiona valores nuevos con existentes (preserva los no actualizados)
      const merged = {
        INF: typeof INF === "string" ? sanitizeString(INF) : current.INF,
        FOR: typeof FOR === "string" ? sanitizeString(FOR) : current.FOR,
        CERT: typeof CERT === "string" ? sanitizeString(CERT) : current.CERT,
      };

      // Actualiza en base de datos con timestamp
      await db.collection(this.collectionName).updateOne(
        { key: "driveFolders" },
        { 
          $set: { 
            key: "driveFolders", 
            value: merged, 
            updatedAt: new Date() 
          } 
        },
        { upsert: true } // Crea si no existe
      );

      // Limpia caché para reflejar cambios inmediatamente
      cacheService.clear("drive_folders_config");
      
      logger.info("Drive folders updated", merged);
      return merged;
    } catch (error) {
      if (error.statusCode) throw error;
      
      logger.error("Failed to update drive folders", error);
      throw createError("Fallo guardando carpetas", 500);
    }
  }

  // Obtiene información de archivo en Drive por ID
  async getDriveFileInfo(fileId) {
    try {
      // Valida que se proporcione ID del archivo
      if (!fileId) {
        throw createError("Falta id", 400);
      }

      // Importa driveService dinámicamente para evitar import circular
      const { driveService } = await import("./driveService.js");
      
      // Delega operación a driveService
      const info = await driveService.getFileInfo(fileId);
      
      return info;
    } catch (error) {
      // Si es error estructurado con código, lo propaga
      if (error.statusCode) throw error;
      
      logger.error("Failed to get drive file info", error);
      throw createError("No se encontró la carpeta", 404);
    }
  }
}

// Exporta instancia única del servicio (singleton pattern)
export const configService = new ConfigService();