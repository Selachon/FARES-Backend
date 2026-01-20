import { connect } from "./db.js";
import { logger, createError, sanitizeString } from "./utils.js";

class ConfigService {
  async getDriveFolders() {
    try {
      const db = await connect();
      const doc = await db.collection("config").findOne({ key: "driveFolders" });
      
      const folders = doc?.value || {
        INF: "",
        FOR: "",
        CERT: ""
      };

      return folders;
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

      const db = await connect();
      
      const currentDoc = await db.collection("config").findOne(
        { key: "driveFolders" },
        { projection: { _id: 0, value: 1 } }
      );

      const current = currentDoc?.value || {
        INF: "",
        FOR: "",
        CERT: ""
      };

      const merged = {
        INF: typeof INF === "string" ? sanitizeString(INF) : current.INF,
        FOR: typeof FOR === "string" ? sanitizeString(FOR) : current.FOR,
        CERT: typeof CERT === "string" ? sanitizeString(CERT) : current.CERT,
      };

      await db.collection("config").updateOne(
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