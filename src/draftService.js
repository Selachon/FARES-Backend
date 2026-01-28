import { connect } from "./db.js";
import { logger, parseUserList, createError, sanitizeString } from "./utils.js";
import { driveService } from "./driveService.js";
import { userService } from "./userService.js";
import { cacheService } from "./cacheService.js";
import { ObjectId } from "mongodb";
import { certificateService } from "./certificateService.js";

class DraftService {
  constructor() {
    this.collectionName = "drafts";
  }

  // --- helpers ---
  isValidEnum(value, allowed) {
    return allowed.includes(String(value || "").trim());
  }

  normalizeDraft(d) {
    return {
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
      links: d.links || { informes: "#", formatos: "#", certificados: "#" },
      source: d.source || "offline_app",
      createdAt: d.createdAt ? new Date(d.createdAt).toISOString() : null,
      updatedAt: d.updatedAt ? new Date(d.updatedAt).toISOString() : null,
    };
  }

  // --- CRUD ---
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
        60 * 1000, // 1 min cache (borradores cambian más seguido)
      );
    } catch (error) {
      logger.error("Failed to get drafts", error);
      throw createError("Error obteniendo borradores", 500);
    }
  }

  async createDraft(data) {
    try {
      const db = await connect();

      // borrador: permite campos faltantes
      const doc = {
        numCert: data.numCert !== undefined && data.numCert !== "" ? Number(data.numCert) : null,
        serial: data.serial !== undefined ? sanitizeString(data.serial) : "",
        fechaCargue: data.fechaCargue ? new Date(data.fechaCargue) : null,
        resultado: data.resultado !== undefined ? sanitizeString(data.resultado) : "",
        empresa: data.empresa !== undefined ? sanitizeString(data.empresa) : "",
        assignedUsers: data.assignedUsers !== undefined ? parseUserList(data.assignedUsers) : [],
        tipoEquipo: data.tipoEquipo !== undefined ? String(data.tipoEquipo).trim().toUpperCase() : null,
        tipoInspeccion: data.tipoInspeccion !== undefined ? String(data.tipoInspeccion).trim().toUpperCase() : null,
        status: "DRAFT",
        links: data.links || { informes: "#", formatos: "#", certificados: "#" },
        source: data.source || "offline_app",
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      // valida enums si vienen
      if (doc.tipoEquipo && !this.isValidEnum(doc.tipoEquipo, ["TE", "CT"])) {
        throw createError("tipoEquipo inválido. Usa TE o CT.", 400);
      }
      if (doc.tipoInspeccion && !this.isValidEnum(doc.tipoInspeccion, ["PARCIAL", "TOTAL"])) {
        throw createError("tipoInspeccion inválido. Usa PARCIAL o TOTAL.", 400);
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

      if (field === "numCert") updates.numCert = data.numCert === "" ? null : Number(data.numCert);
      else if (field === "fechaCargue") updates.fechaCargue = data.fechaCargue ? new Date(data.fechaCargue) : null;
      else if (field === "assignedUsers") updates.assignedUsers = parseUserList(data.assignedUsers);
      else if (field === "tipoEquipo") updates.tipoEquipo = data.tipoEquipo ? String(data.tipoEquipo).trim().toUpperCase() : null;
      else if (field === "tipoInspeccion") updates.tipoInspeccion = data.tipoInspeccion ? String(data.tipoInspeccion).trim().toUpperCase() : null;
      else if (field === "links") updates.links = data.links;
      else updates[field] = sanitizeString(data[field]);
    }

    // valida enums si vienen
    if (updates.tipoEquipo && !this.isValidEnum(updates.tipoEquipo, ["TE", "CT"])) {
      throw createError("tipoEquipo inválido. Usa TE o CT.", 400);
    }
    if (updates.tipoInspeccion && !this.isValidEnum(updates.tipoInspeccion, ["PARCIAL", "TOTAL"])) {
      throw createError("tipoInspeccion inválido. Usa PARCIAL o TOTAL.", 400);
    }

    updates.updatedAt = new Date();
    return updates;
  }

  async updateDraft(id, updateData, files) {
    try {
      const _id = new ObjectId(id);
      const db = await connect();

      const existing = await db.collection(this.collectionName).findOne({ _id });
      if (!existing) throw createError("No existe el borrador", 404);

      const updates = this.buildDraftUpdates(existing, updateData);

      // si vienen archivos, los subimos y guardamos links en el draft
      const hasFiles = files && Object.keys(files).length > 0;
      if (hasFiles) {
        const effective = { ...existing, ...updates };

        const meta = {
          Usuario: (effective.assignedUsers || []).join(","),
          NumCert: String(effective.numCert || "DRAFT"),
          Serial: String(effective.serial || "DRAFT"),
        };

        const newLinks = await driveService.uploadCertificateFiles(
          files,
          meta,
          effective.empresa || "DRAFT",
          effective.numCert || "DRAFT",
          effective.serial || "DRAFT"
        );

        updates.links = { ...(existing.links || {}), ...newLinks };
      }

      await db.collection(this.collectionName).updateOne({ _id }, { $set: updates });
      const updated = await db.collection(this.collectionName).findOne({ _id });

      cacheService.clear("all_drafts");
      return this.normalizeDraft(updated);
    } catch (error) {
      if (error.statusCode) throw error;
      logger.error("Failed to update draft", error);
      throw createError("Error actualizando borrador", 500);
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

  // --- publish ---
  validatePublishableDraft(d) {
    const missing = [];

    const numCertOk = typeof d.numCert === "number" && !Number.isNaN(d.numCert);
    if (!numCertOk) missing.push("numCert");

    if (!String(d.serial || "").trim()) missing.push("serial");
    if (!String(d.empresa || "").trim()) missing.push("empresa");

    const au = Array.isArray(d.assignedUsers) ? d.assignedUsers : [];
    if (au.length === 0) missing.push("assignedUsers");

    const te = String(d.tipoEquipo || "").trim().toUpperCase();
    const ti = String(d.tipoInspeccion || "").trim().toUpperCase();

    if (!this.isValidEnum(te, ["TE", "CT"])) missing.push("tipoEquipo");
    if (!this.isValidEnum(ti, ["PARCIAL", "TOTAL"])) missing.push("tipoInspeccion");

    const links = d.links || {};
    const linkMissing = [];
    if (!links.informes || links.informes === "#") linkMissing.push("informes");
    if (!links.formatos || links.formatos === "#") linkMissing.push("formatos");
    if (!links.certificados || links.certificados === "#") linkMissing.push("certificados");

    if (missing.length || linkMissing.length) {
      const msgParts = [];
      if (missing.length) msgParts.push(`Campos faltantes: ${missing.join(", ")}`);
      if (linkMissing.length) msgParts.push(`Archivos faltantes: ${linkMissing.join(", ")}`);
      throw createError(`No se puede publicar. ${msgParts.join(" | ")}`, 400);
    }

    return { te, ti };
  }

  async publishDraft(id) {
    try {
      const _id = new ObjectId(id);
      const db = await connect();

      const draft = await db.collection(this.collectionName).findOne({ _id });
      if (!draft) throw createError("No existe el borrador", 404);

      const { te, ti } = this.validatePublishableDraft(draft);

      // valida usuarios existen para esa empresa
      await userService.validateUsersExist(draft.assignedUsers, draft.empresa);

      // construye doc final en certificates
      const document = {
        numCert: Number(draft.numCert),
        serial: sanitizeString(draft.serial),
        fechaCargue: draft.fechaCargue ? new Date(draft.fechaCargue) : new Date(),
        resultado: sanitizeString(draft.resultado || "CUMPLE"),
        empresa: sanitizeString(draft.empresa),
        assignedUsers: Array.isArray(draft.assignedUsers) ? draft.assignedUsers : [],
        tipoEquipo: te,
        tipoInspeccion: ti,
        status: "ACTIVO",
        renewedAt: null,
        links: draft.links || { informes: "#", formatos: "#", certificados: "#" },
        createdAt: new Date(),
      };

      const computed = certificateService.computeExpiry(document);
      if (computed?.computedStatus) document.status = computed.computedStatus;

      const insert = await db.collection("certificates").insertOne(document);
      await db.collection(this.collectionName).deleteOne({ _id });

      cacheService.clear("all_certificates");
      cacheService.clear("all_drafts");

      const created = await db.collection("certificates").findOne({ _id: insert.insertedId });
      return certificateService.normalizeCertificate(created);
    } catch (error) {
      if (error.statusCode) throw error;
      logger.error("Failed to publish draft", error);
      throw createError("Error publicando borrador", 500);
    }
  }
}

export const draftService = new DraftService();
