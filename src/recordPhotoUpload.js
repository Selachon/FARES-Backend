import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { ObjectId } from "mongodb";
import { createError, logger } from "./utils.js";
import { isValidPhotoCategory } from "./inspectionTypes.js";

// Shared by the web upload endpoints. Read raw records to retain Drive storage IDs.
export function createRecordPhotoUpload({ connect, driveService, cacheService, getSectionName, parentFolderId }) {
  return async function uploadRecordPhoto(collectionName, req, res) {
    const file = req.file;
    if (!file) throw createError("Se requiere una foto", 400, "MISSING_PHOTO");

    let uploadedFileId = null;
    let persisted = false;
    try {
      const extensions = { "image/jpeg": ".jpg", "image/png": ".png" };
      const extension = extensions[file.mimetype];
      if (!extension) throw createError("Selecciona una imagen JPG o PNG", 400, "INVALID_PHOTO_TYPE");
      const category = req.body.category || "superficie";
      if (!isValidPhotoCategory(category)) throw createError("Categoría de foto inválida", 400, "INVALID_PHOTO_CATEGORY");
      if (!ObjectId.isValid(req.params.id)) throw createError("Registro inválido", 400);

      const db = await connect();
      const collection = db.collection(collectionName);
      const _id = new ObjectId(req.params.id);
      const record = await collection.findOne({ _id });
      if (!record) throw createError("No existe el registro", 404);

      const description = String(req.body.description || "");
      if (description.startsWith("acc:")) {
        const accessoryId = description.slice(4);
        const accessories = record.inspeccionCompleta?.conexionesAccesorios?.accesorios || [];
        if (category !== "roscas_conexiones" || !accessories.some((acc) => String(acc.id) === accessoryId)) {
          throw createError("Guarda el accesorio antes de subir sus fotos", 400, "INVALID_ACCESSORY");
        }
      }

      let storage = { ...(record.storage || {}) };
      let folderId;
      try {
        if (!storage.rootFolderId && record.numCert && !record.noConsecutive) {
          storage = { ...storage, ...await driveService.ensureCertificateFolderTree(record.numCert) };
        }
        if (storage.rootFolderId) {
          if (!storage.registrosFotograficosFolderId) {
            const folder = await driveService.ensureFolder("Registros fotográficos", storage.rootFolderId);
            storage.registrosFotograficosFolderId = folder.id;
          }
          folderId = storage.sectionFolders?.[category];
          if (!folderId) {
            const folder = await driveService.ensurePhotoSectionFolder(storage.registrosFotograficosFolderId, getSectionName(category));
            folderId = folder.id;
          }
        } else if (record.noConsecutive) {
          // Visits without a consecutive number retain the mobile app's existing destination.
          const folders = await driveService.getDriveFolders();
          folderId = folders.INF || parentFolderId;
        }
        if (!folderId) throw new Error("No se pudo resolver la carpeta del registro");

        const fallback = collectionName === "drafts" ? "DRAFT" : "CERT";
        const uploaded = await driveService.uploadFile({
          localPath: file.path,
          fileName: `FOTO_${record.serial || fallback}_${category}_${Date.now()}${extension}`,
          mimeType: file.mimetype,
          appProperties: {
            NumCert: String(record.numCert || fallback),
            Serial: String(record.serial || fallback),
            Category: category,
          },
          folderId,
        });
        uploadedFileId = uploaded?.id;
        if (!uploadedFileId) throw new Error("Drive no devolvió el identificador de la foto");

        const photo = {
          id: `photo_${randomUUID()}`,
          category,
          description,
          timestamp: new Date().toISOString(),
          includeInPdf: req.body.includeInPdf !== "false",
          driveFileId: uploadedFileId,
          driveUrl: uploaded.webViewLink || `https://drive.google.com/file/d/${uploadedFileId}/view`,
          thumbnailUrl: driveService.getThumbnailUrl(uploadedFileId) || uploaded.thumbnailLink || null,
        };

        // Append atomically so concurrent uploads do not overwrite each other's photos or sections.
        const updates = {
          fotos: { $concatArrays: [{ $ifNull: ["$fotos", []] }, { $literal: [photo] }] },
          updatedAt: new Date(),
        };
        if (storage.rootFolderId) {
          const { sectionFolders, ...tree } = storage;
          const rootLink = storage.rootFolderLink || `https://drive.google.com/drive/folders/${storage.rootFolderId}`;
          updates.storage = { $mergeObjects: [
            { $ifNull: ["$storage", {}] },
            { $literal: { ...tree, rootFolderLink: rootLink } },
            { sectionFolders: { $mergeObjects: [
              { $ifNull: ["$storage.sectionFolders", {}] },
              { $literal: { [category]: folderId } },
            ] } },
          ] };
          updates.links = { $mergeObjects: [{ $ifNull: ["$links", {}] }, { $literal: { driveFolder: rootLink } }] };
        }
        const result = await collection.updateOne({ _id }, [{ $set: updates }]);
        if (!result.matchedCount) throw createError("No existe el registro", 404);
        persisted = true;
        cacheService.clear(collectionName === "drafts" ? "all_drafts" : "all_certificates");
        if (collectionName === "certificates") cacheService.clearPrefix("certs_user_");
        return res.status(201).json(photo);
      } catch (error) {
        logger.warn("Could not save record photo", { error: error.message });
        if (error.statusCode) throw error;
        throw createError("No se pudo guardar la foto en Drive y en el registro. Reintenta la carga.", 502, "PHOTO_UPLOAD_FAILED");
      }
    } finally {
      if (uploadedFileId && !persisted) {
        try { await driveService.deleteFile(uploadedFileId); }
        catch (error) { logger.warn("Could not clean up unlinked photo", { fileId: uploadedFileId, error: error.message }); }
      }
      try { await fs.unlink(file.path); }
      catch (error) {
        if (error.code !== "ENOENT") logger.warn("Could not remove temporary photo", { error: error.message });
      }
    }
  };
}
