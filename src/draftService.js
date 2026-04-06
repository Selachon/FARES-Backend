// Servicio de gestión de borradores de certificados
// Permite crear y editar borradores antes de publicarlos como certificados definitivos
import { connect } from "./db.js";
import { logger, parseUserList, createError, sanitizeString } from "./utils.js";
import { driveService } from "./driveService.js";
import { userService } from "./userService.js";
import { cacheService } from "./cacheService.js";
import { ObjectId } from "mongodb";
import { certificateService } from "./certificateService.js";
import {
  PHOTO_CATEGORY_LABELS,
  normalizeInspeccionCompleta,
  normalizePhotos,
} from "./inspectionTypes.js";

class DraftService {
  constructor() {
    this.collectionName = "drafts";
  }

  
  isValidEnum(value, allowed) {
    return allowed.includes(String(value || "").trim());
  }

  normalizeDraft(d, options = {}) {
    const { includeFullInspection = false } = options;
    
    const base = {
      id: d._id?.toString?.() || d.id,
      numCert: d.numCert ?? null,
      serial: d.serial ?? "",
      fechaCargue: d.fechaCargue ? new Date(d.fechaCargue).toISOString() : null,
      resultado: d.resultado ?? "",
      empresa: d.empresa ?? "",
      assignedUsers: Array.isArray(d.assignedUsers) ? d.assignedUsers : [],
      tipoEquipo: d.tipoEquipo ?? null,
      tipoInspeccion: d.tipoInspeccion ?? null,
      status: d.status ?? "DRAFT",
      links: d.links || { informes: "#", formatos: "#", certificados: "#", anexos: "#", driveFolder: "#" },
      source: d.source || "offline_app",
      createdAt: d.createdAt ? new Date(d.createdAt).toISOString() : null,
      updatedAt: d.updatedAt ? new Date(d.updatedAt).toISOString() : null,
      localId: d.localId || null,
      // Indicar si tiene inspección completa (para UI)
      hasInspeccionCompleta: !!d.inspeccionCompleta,
      // Número de fotos (para UI)
      photosCount: Array.isArray(d.fotos) ? d.fotos.length : 0,
    };

    // Incluir datos completos solo si se solicita (para vista detallada)
    if (includeFullInspection) {
      base.inspeccionCompleta = d.inspeccionCompleta 
        ? normalizeInspeccionCompleta(d.inspeccionCompleta)
        : null;
      base.fotos = normalizePhotos(d.fotos);
    }

    return base;
  }

  async getNextDraftNumber(db) {
    const [latestDraft, latestCertificate] = await Promise.all([
      db
        .collection(this.collectionName)
        .find({ numCert: { $type: "number" } })
        .sort({ numCert: -1 })
        .limit(1)
        .toArray(),
      db
        .collection("certificates")
        .find({ numCert: { $type: "number" } })
        .sort({ numCert: -1 })
        .limit(1)
        .toArray(),
    ]);

    const maxDraft = latestDraft?.[0]?.numCert || 0;
    const maxCertificate = latestCertificate?.[0]?.numCert || 0;
    return Math.max(maxDraft, maxCertificate) + 1;
  }

  
  async getAllDrafts() {
    try {
      return await cacheService.getOrSet(
        "all_drafts",
        async () => {
          const db = await connect();
          const drafts = await db
            .collection(this.collectionName)
            .find({})
            .sort({ createdAt: -1 })
            .toArray();

          return drafts.map((d) => this.normalizeDraft(d));
        },
        60 * 1000,
      );
    } catch (error) {
      logger.error("Failed to get drafts", error);
      throw createError("Error obteniendo borradores", 500);
    }
  }

  async createDraft(data, files = {}) {
    try {
      const db = await connect();
      const localId = data.localId ? sanitizeString(data.localId) : null;

      // IDEMPOTENCY CHECK FIRST: Prevent duplicate uploads on retries
      // Must happen BEFORE any side effects (file uploads)
      if (localId) {
        const collection = db.collection(this.collectionName);
        const existing = await collection.findOne({ localId });
        if (existing) {
          const now = new Date();
          const patch = {};

          const countFilledValues = (value) => {
            if (value === null || value === undefined) return 0;
            if (Array.isArray(value)) {
              return value.reduce((sum, item) => sum + countFilledValues(item), 0);
            }
            if (typeof value === "object") {
              return Object.values(value).reduce(
                (sum, item) => sum + countFilledValues(item),
                0,
              );
            }
            if (typeof value === "string") return value.trim() ? 1 : 0;
            if (typeof value === "number") return Number.isFinite(value) ? 1 : 0;
            if (typeof value === "boolean") return 1;
            return 0;
          };

          const existingInspection = existing.inspeccionCompleta
            ? normalizeInspeccionCompleta(existing.inspeccionCompleta)
            : null;
          const incomingInspection = data.inspeccionCompleta
            ? normalizeInspeccionCompleta(data.inspeccionCompleta)
            : null;
          const incomingSource = sanitizeString(data.source || existing.source || "")
            .toLowerCase();
          const isAppSource = incomingSource === "offline_app";

          const existingInspectionMissingCore =
            !existingInspection ||
            !String(existingInspection?.informacionItem?.numeroSerie || "").trim() ||
            !String(existingInspection?.datosCliente?.cliente || "").trim();

          const incomingInspectionHasCore =
            !!incomingInspection &&
            (String(incomingInspection?.informacionItem?.numeroSerie || "").trim() ||
              String(incomingInspection?.datosCliente?.cliente || "").trim() ||
              String(incomingInspection?.datosCliente?.nit || "").trim());
          const existingInspectionScore = countFilledValues(existingInspection);
          const incomingInspectionScore = countFilledValues(incomingInspection);
          const incomingIsNotWorse = incomingInspectionScore >= existingInspectionScore;

          if (
            incomingInspectionHasCore &&
            (existingInspectionMissingCore ||
              incomingInspectionScore > existingInspectionScore ||
              (isAppSource && incomingIsNotWorse))
          ) {
            patch.inspeccionCompleta = incomingInspection;
          }

          const existingPhotos = normalizePhotos(existing.fotos);
          const incomingPhotos = normalizePhotos(data.fotos);
          if (incomingPhotos.length > 0) {
            const photoQualityScore = (photo) => {
              if (!photo) return 0;
              let score = 0;
              if (photo.driveFileId) score += 4;
              if (photo.driveUrl) score += 3;
              if (photo.thumbnailUrl) score += 1;
              if (photo.description) score += 1;
              if (photo.timestamp) score += 1;
              return score;
            };

            const photoKey = (photo, index) =>
              String(
                photo?.id ||
                  `${photo?.category || "photo"}_${photo?.timestamp || index}`,
              );

            const mergedPhotosMap = new Map();
            existingPhotos.forEach((photo, index) => {
              mergedPhotosMap.set(photoKey(photo, index), photo);
            });
            incomingPhotos.forEach((photo, index) => {
              const key = photoKey(photo, index);
              const current = mergedPhotosMap.get(key);
              if (!current || photoQualityScore(photo) >= photoQualityScore(current)) {
                mergedPhotosMap.set(key, photo);
              }
            });

            const mergedPhotos = Array.from(mergedPhotosMap.values());
            const mergedChanged =
              JSON.stringify(mergedPhotos) !== JSON.stringify(existingPhotos);
            const shouldPatchPhotos =
              incomingPhotos.length > existingPhotos.length ||
              (isAppSource && mergedChanged);

            if (shouldPatchPhotos) {
              patch.fotos = mergedPhotos;
            }
          }

          const existingNumCert = Number(existing.numCert);
          if (!existing.numCert || Number.isNaN(existingNumCert)) {
            patch.numCert = await this.getNextDraftNumber(db);
          }

          if (!String(existing.serial || "").trim() && data.serial !== undefined) {
            patch.serial = sanitizeString(data.serial);
          }

          if (!String(existing.empresa || "").trim() && data.empresa !== undefined) {
            patch.empresa = sanitizeString(data.empresa);
          }

          if (!String(existing.resultado || "").trim() && data.resultado !== undefined) {
            patch.resultado = sanitizeString(data.resultado);
          }

          const incomingTipoEquipo =
            data.tipoEquipo !== undefined
              ? String(data.tipoEquipo).trim().toUpperCase()
              : "";
          if (
            !String(existing.tipoEquipo || "").trim() &&
            this.isValidEnum(incomingTipoEquipo, ["TE", "CT"])
          ) {
            patch.tipoEquipo = incomingTipoEquipo;
          }

          const incomingTipoInspeccion =
            data.tipoInspeccion !== undefined
              ? String(data.tipoInspeccion).trim().toUpperCase()
              : "";
          if (
            !String(existing.tipoInspeccion || "").trim() &&
            this.isValidEnum(incomingTipoInspeccion, ["PARCIAL", "TOTAL"])
          ) {
            patch.tipoInspeccion = incomingTipoInspeccion;
          }

          const existingAssignedUsers = Array.isArray(existing.assignedUsers)
            ? existing.assignedUsers
            : [];
          const incomingAssignedUsers = parseUserList(data.assignedUsers);
          if (existingAssignedUsers.length === 0 && incomingAssignedUsers.length > 0) {
            patch.assignedUsers = incomingAssignedUsers;
          }

          const incomingFechaCargue = data.fechaCargue
            ? new Date(data.fechaCargue)
            : null;
          if (
            !existing.fechaCargue &&
            incomingFechaCargue &&
            !Number.isNaN(incomingFechaCargue.getTime())
          ) {
            patch.fechaCargue = incomingFechaCargue;
          }

          const incomingFormatosLink = sanitizeString(data.links?.formatos);
          if (incomingFormatosLink && incomingFormatosLink !== "#") {
            const existingLinks = existing.links || {};
            const existingFormatosLink = sanitizeString(existingLinks.formatos);
            if (!existingFormatosLink || existingFormatosLink === "#") {
              patch.links = { ...existingLinks, formatos: incomingFormatosLink };
            }
          }

          const incomingStorage =
            data.storage && typeof data.storage === "object" ? data.storage : null;
          if (incomingStorage?.rootFolderId) {
            const existingStorage =
              existing.storage && typeof existing.storage === "object"
                ? existing.storage
                : {};
            const mergedStorage = {
              ...existingStorage,
              ...incomingStorage,
              sectionFolders: {
                ...(existingStorage.sectionFolders || {}),
                ...(incomingStorage.sectionFolders || {}),
              },
            };

            if (JSON.stringify(mergedStorage) !== JSON.stringify(existingStorage)) {
              patch.storage = mergedStorage;
            }
          }

          if (Object.keys(patch).length > 0) {
            patch.updatedAt = now;
            await collection.updateOne({ _id: existing._id }, { $set: patch });
            const refreshed = await collection.findOne({ _id: existing._id });
            cacheService.clear("all_drafts");
            logger.info("Draft already exists, refreshed with incoming data", {
              localId,
              patchedFields: Object.keys(patch),
            });
            return this.normalizeDraft(refreshed);
          }

          logger.info("Draft already exists, returning existing", { localId });
          return this.normalizeDraft(existing);
        }
      }

      const doc = {
        numCert:
          data.numCert !== undefined && data.numCert !== ""
            ? Number(data.numCert)
            : null,
        serial: data.serial !== undefined ? sanitizeString(data.serial) : "",
        fechaCargue: data.fechaCargue ? new Date(data.fechaCargue) : null,
        resultado:
          data.resultado !== undefined ? sanitizeString(data.resultado) : "",
        empresa: data.empresa !== undefined ? sanitizeString(data.empresa) : "",
        assignedUsers:
          data.assignedUsers !== undefined
            ? parseUserList(data.assignedUsers)
            : [],
        tipoEquipo:
          data.tipoEquipo !== undefined
            ? String(data.tipoEquipo).trim().toUpperCase()
            : null,
        tipoInspeccion:
          data.tipoInspeccion !== undefined
            ? String(data.tipoInspeccion).trim().toUpperCase()
            : null,
        status: "DRAFT",
        links: data.links || {
          informes: "#",
          formatos: "#",
          certificados: "#",
          anexos: "#",
          driveFolder: "#",
        },
        source: data.source || "offline_app",
        createdAt: new Date(),
        updatedAt: new Date(),
        localId,
        storage:
          data.storage && typeof data.storage === "object" ? data.storage : null,
        // Nuevo: Inspección completa (datos del formulario de la app)
        inspeccionCompleta: data.inspeccionCompleta 
          ? normalizeInspeccionCompleta(data.inspeccionCompleta)
          : null,
        // Nuevo: Fotos de la inspección
        fotos: normalizePhotos(data.fotos),
      };

      if (!doc.numCert || Number.isNaN(doc.numCert)) {
        doc.numCert = await this.getNextDraftNumber(db);
      }

      // Validate enums before any uploads
      if (doc.tipoEquipo && !this.isValidEnum(doc.tipoEquipo, ["TE", "CT"])) {
        throw createError("tipoEquipo inválido. Usa TE o CT.", 400);
      }
      if (
        doc.tipoInspeccion &&
        !this.isValidEnum(doc.tipoInspeccion, ["PARCIAL", "TOTAL"])
      ) {
        throw createError("tipoInspeccion inválido. Usa PARCIAL o TOTAL.", 400);
      }

      // Now safe to upload files (after idempotency and validation checks)
      const hasFiles = files && Object.keys(files).length > 0;
      if (hasFiles) {
        const meta = {
          Usuario: (doc.assignedUsers || []).join(","),
          NumCert: String(doc.numCert || "DRAFT"),
          Serial: String(doc.serial || "DRAFT"),
        };

        const uploadResult = await driveService.uploadCertificateFiles(
          files,
          meta,
          doc.empresa || "DRAFT",
          doc.numCert || "DRAFT",
          doc.serial || "DRAFT",
        );

        // Extraer storage para persistencia
        const storage = uploadResult?._storage || null;
        delete uploadResult?._storage;

        const cleanedLinks = Object.fromEntries(
          Object.entries(uploadResult || {}).filter(([, v]) => v && v !== "#")
        );

        doc.links = { ...(doc.links || {}), ...cleanedLinks };
        
        // Guardar storage si se creó
        if (storage) {
          doc.storage = storage;
        }
      }

      const result = await db.collection(this.collectionName).insertOne(doc);
      cacheService.clear("all_drafts");

      return this.normalizeDraft({ ...doc, _id: result.insertedId });
    } catch (error) {
      if (error.statusCode) throw error;
      logger.error("Failed to create draft", error);
      throw createError("Error creando borrador", 500);
    }
  }

  buildDraftUpdates(existing, data) {
    const updates = {};
    const allowed = [
      "numCert",
      "serial",
      "fechaCargue",
      "empresa",
      "assignedUsers",
      "resultado",
      "tipoEquipo",
      "tipoInspeccion",
      "links",
      "source",
    ];

    for (const field of allowed) {
      if (data[field] === undefined) continue;

      if (field === "numCert")
        updates.numCert = data.numCert === "" ? null : Number(data.numCert);
      else if (field === "fechaCargue")
        updates.fechaCargue = data.fechaCargue
          ? new Date(data.fechaCargue)
          : null;
      else if (field === "assignedUsers")
        updates.assignedUsers = parseUserList(data.assignedUsers);
      else if (field === "tipoEquipo")
        updates.tipoEquipo = data.tipoEquipo
          ? String(data.tipoEquipo).trim().toUpperCase()
          : null;
      else if (field === "tipoInspeccion")
        updates.tipoInspeccion = data.tipoInspeccion
          ? String(data.tipoInspeccion).trim().toUpperCase()
          : null;
      else if (field === "links") updates.links = data.links;
      else updates[field] = sanitizeString(data[field]);
    }

    // Nuevo: Actualizar inspección completa si viene en los datos
    if (data.inspeccionCompleta !== undefined) {
      updates.inspeccionCompleta = data.inspeccionCompleta
        ? normalizeInspeccionCompleta(data.inspeccionCompleta)
        : existing.inspeccionCompleta;
    }

    // Nuevo: Actualizar fotos si vienen en los datos
    if (data.fotos !== undefined) {
      updates.fotos = normalizePhotos(data.fotos);
    }

    // valida enums si vienen
    if (
      updates.tipoEquipo &&
      !this.isValidEnum(updates.tipoEquipo, ["TE", "CT"])
    ) {
      throw createError("tipoEquipo inválido. Usa TE o CT.", 400);
    }
    if (
      updates.tipoInspeccion &&
      !this.isValidEnum(updates.tipoInspeccion, ["PARCIAL", "TOTAL"])
    ) {
      throw createError("tipoInspeccion inválido. Usa PARCIAL o TOTAL.", 400);
    }

    updates.updatedAt = new Date();
    return updates;
  }

  async updateDraft(id, updateData, files) {
    try {
      const _id = new ObjectId(id);
      const db = await connect();

      const existing = await db
        .collection(this.collectionName)
        .findOne({ _id });
      if (!existing) throw createError("No existe el borrador", 404);

      const updates = this.buildDraftUpdates(existing, updateData);

      const hasFiles = files && Object.keys(files).length > 0;
      if (hasFiles) {
        const effective = { ...existing, ...updates };

        const meta = {
          Usuario: (effective.assignedUsers || []).join(","),
          NumCert: String(effective.numCert || "DRAFT"),
          Serial: String(effective.serial || "DRAFT"),
        };

        // Obtener o crear storage
        let storage = existing.storage;
        if (!storage?.rootFolderId && effective.numCert && effective.numCert !== "DRAFT") {
          storage = await driveService.ensureCertificateFolderTree(effective.numCert);
        }

        const uploadResult = await driveService.uploadCertificateFiles(
          files,
          meta,
          effective.empresa || "DRAFT",
          effective.numCert || "DRAFT",
          effective.serial || "DRAFT",
          storage,
        );

        // Extraer storage
        const newStorage = uploadResult?._storage;
        delete uploadResult?._storage;

        const cleanedLinks = Object.fromEntries(
          Object.entries(uploadResult || {}).filter(([, v]) => v && v !== "#")
        );

        if (Object.keys(cleanedLinks).length > 0) {
          updates.links = { ...(existing.links || {}), ...cleanedLinks };
        }

        // Guardar storage si se creó
        if (newStorage && !existing.storage?.rootFolderId) {
          updates.storage = newStorage;
        }
      }

      await db
        .collection(this.collectionName)
        .updateOne({ _id }, { $set: updates });
      const updated = await db.collection(this.collectionName).findOne({ _id });

      cacheService.clear("all_drafts");
      return this.normalizeDraft(updated);
    } catch (error) {
      if (error.statusCode) throw error;
      logger.error("Failed to update draft", error);
      throw createError("Error actualizando borrador", 500);
    }
  }

  /**
   * Obtiene un borrador por ID con todos los detalles (inspección completa y fotos)
   */
  async getDraftById(id) {
    try {
      const _id = new ObjectId(id);
      const db = await connect();

      const draft = await db.collection(this.collectionName).findOne({ _id });
      if (!draft) throw createError("No existe el borrador", 404);

      return this.normalizeDraft(draft, { includeFullInspection: true });
    } catch (error) {
      if (error.statusCode) throw error;
      logger.error("Failed to get draft by id", error);
      throw createError("Error obteniendo borrador", 500);
    }
  }

  async deleteDraftsByIds(ids) {
    try {
      if (!Array.isArray(ids) || ids.length === 0) {
        throw createError("Lista vacía", 400);
      }

      const objectIds = ids.map((x) => new ObjectId(String(x)));
      const db = await connect();

      const result = await db.collection(this.collectionName).deleteMany({
        _id: { $in: objectIds },
      });

      cacheService.clear("all_drafts");
      logger.info("Drafts deleted", { count: result.deletedCount });

      return { ok: true, deleted: result.deletedCount };
    } catch (error) {
      if (error.statusCode) throw error;
      logger.error("Failed to delete drafts", error);
      throw createError("Error eliminando borradores", 500);
    }
  }

  
  validatePublishableDraft(d) {
    const missing = [];
    const validEquipos = ["TE", "CT"];
    const validInspecciones = ["PARCIAL", "TOTAL"];

    const numCertOk = typeof d.numCert === "number" && !Number.isNaN(d.numCert);
    if (!numCertOk) missing.push("numCert");

    if (!String(d.serial || "").trim()) missing.push("serial");
    if (!String(d.empresa || "").trim()) missing.push("empresa");

    const au = Array.isArray(d.assignedUsers) ? d.assignedUsers : [];
    if (au.length === 0) missing.push("assignedUsers");

    const te = String(d.tipoEquipo || "").trim().toUpperCase();
    const ti = String(d.tipoInspeccion || "").trim().toUpperCase();

    if (!this.isValidEnum(te, validEquipos)) missing.push("tipoEquipo");
    if (!this.isValidEnum(ti, validInspecciones)) missing.push("tipoInspeccion");

    if (missing.length) {
      throw createError(
        `No se puede publicar. Campos faltantes: ${missing.join(", ")}`,
        400,
      );
    }

    return { te, ti };
  }

  sanitizeFolderName(name) {
    return String(name || "Otros")
      .replace(/[\\/]/g, " - ")
      .replace(/\s+/g, " ")
      .trim();
  }

  getPhotoSectionFolderName(category) {
    const label = PHOTO_CATEGORY_LABELS[String(category || "")] || "Otros";
    return this.sanitizeFolderName(label);
  }

  async organizeDriveAssetsForPublish(draft) {
    const links = { ...(draft.links || {}) };
    const photos = Array.isArray(draft.fotos) ? [...draft.fotos] : [];
    let storage = draft.storage || null;
    const trace = {
      filesMoved: 0,
      filesMoveErrors: 0,
      photosMoved: 0,
      photosMoveErrors: 0,
      sectionsCreated: 0,
    };

    if (!draft.numCert) {
      return { links, photos, storage };
    }

    try {
      if (!storage?.rootFolderId) {
        storage = await driveService.ensureCertificateFolderTree(draft.numCert);
      }

      if (!storage?.rootFolderId) {
        return { links, photos, storage };
      }

      if (!links.driveFolder || links.driveFolder === "#") {
        links.driveFolder =
          storage.rootFolderLink ||
          `https://drive.google.com/drive/folders/${storage.rootFolderId}`;
      }

      logger.info("Publish drive organization started", {
        numCert: draft.numCert,
        rootFolderId: storage.rootFolderId,
        registrosFotograficosFolderId: storage.registrosFotograficosFolderId,
        photosWithDriveId: photos.filter((p) => p?.driveFileId).length,
      });

      const fileLinkKeys = ["informes", "formatos", "certificados", "anexos"];
      for (const key of fileLinkKeys) {
        const link = links[key];
        const fileId = driveService.extractFileIdFromLink(link);
        if (!fileId) continue;

        try {
          const moved = await driveService.moveFile(fileId, storage.rootFolderId);
          trace.filesMoved += 1;
          if (moved?.webViewLink) {
            links[key] = moved.webViewLink;
          }
        } catch (error) {
          trace.filesMoveErrors += 1;
          logger.warn("Could not move draft file during publish", {
            key,
            fileId,
            numCert: draft.numCert,
            error: error.message,
          });
        }
      }

      if (!storage.registrosFotograficosFolderId || photos.length === 0) {
        return { links, photos, storage };
      }

      const sectionFolders = { ...(storage.sectionFolders || {}) };

      for (let i = 0; i < photos.length; i += 1) {
        const photo = photos[i];
        if (!photo?.driveFileId) continue;

        const category = String(photo.category || "otros");
        let sectionFolderId = sectionFolders[category] || null;

        if (!sectionFolderId) {
          try {
            const sectionName = this.getPhotoSectionFolderName(category);
            const folder = await driveService.ensurePhotoSectionFolder(
              storage.registrosFotograficosFolderId,
              sectionName,
            );
            sectionFolderId = folder?.id || null;
            if (sectionFolderId) {
              sectionFolders[category] = sectionFolderId;
              trace.sectionsCreated += 1;
            }
          } catch (error) {
            logger.warn("Could not ensure photo section folder during publish", {
              category,
              numCert: draft.numCert,
              error: error.message,
            });
            continue;
          }
        }

        if (!sectionFolderId) continue;

        try {
          const moved = await driveService.moveFile(photo.driveFileId, sectionFolderId);
          trace.photosMoved += 1;
          if (moved?.webViewLink) {
            photos[i] = { ...photo, driveUrl: moved.webViewLink };
          }
        } catch (error) {
          trace.photosMoveErrors += 1;
          logger.warn("Could not move photo during draft publish", {
            photoId: photo.id,
            driveFileId: photo.driveFileId,
            category,
            numCert: draft.numCert,
            error: error.message,
          });
        }
      }

      storage = {
        ...storage,
        sectionFolders,
      };

      logger.info("Publish drive organization completed", {
        numCert: draft.numCert,
        ...trace,
      });

      return { links, photos, storage };
    } catch (error) {
      logger.warn("Drive organization skipped during draft publish", {
        numCert: draft.numCert,
        error: error.message,
      });
      return { links, photos, storage };
    }
  }

  async publishDraft(id) {
    try {
      const _id = new ObjectId(id);
      const db = await connect();

      const draft = await db.collection(this.collectionName).findOne({ _id });
      if (!draft) throw createError("No existe el borrador", 404);

      const { te, ti } = this.validatePublishableDraft(draft);

      const preparedDriveAssets = await this.organizeDriveAssetsForPublish(draft);

      
      await userService.validateUsersExist(draft.assignedUsers, draft.empresa);

      
      const document = {
        numCert: Number(draft.numCert),
        serial: sanitizeString(draft.serial),
        fechaCargue: draft.fechaCargue
          ? new Date(draft.fechaCargue)
          : new Date(),
        resultado: sanitizeString(draft.resultado || "CUMPLE"),
        empresa: sanitizeString(draft.empresa),
        assignedUsers: Array.isArray(draft.assignedUsers)
          ? draft.assignedUsers
          : [],
        tipoEquipo: te,
        tipoInspeccion: ti,
        status: "ACTIVO",
        renewedAt: null,
        links: preparedDriveAssets.links || {
          informes: "#",
          formatos: "#",
          certificados: "#",
          anexos: "#",
          driveFolder: "#",
        },
        createdAt: new Date(),
        // Nuevo: Copiar inspección completa del borrador
        inspeccionCompleta: draft.inspeccionCompleta || null,
        // Nuevo: Copiar fotos del borrador
        fotos: Array.isArray(preparedDriveAssets.photos)
          ? preparedDriveAssets.photos
          : [],
        // Copiar storage si existe
        storage: preparedDriveAssets.storage || draft.storage || null,
      };

      const computed = certificateService.computeExpiry(document);
      if (computed?.computedStatus) document.status = computed.computedStatus;

      const insert = await db.collection("certificates").insertOne(document);
      await db.collection(this.collectionName).deleteOne({ _id });

      cacheService.clear("all_certificates");
      cacheService.clear("all_drafts");

      const created = await db
        .collection("certificates")
        .findOne({ _id: insert.insertedId });
      return certificateService.normalizeCertificate(created);
    } catch (error) {
      if (error.statusCode) throw error;
      logger.error("Failed to publish draft", error);
      throw createError("Error publicando borrador", 500);
    }
  }
}

export const draftService = new DraftService();
