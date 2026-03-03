// Servicio de gestión de certificados
// Maneja creación, actualización, borrado y consulta de certificados técnicos
import { connect } from "./db.js";
import { logger, parseUserList, createError, sanitizeString } from "./utils.js";
import { driveService } from "./driveService.js";
import { userService } from "./userService.js";
import { cacheService } from "./cacheService.js";
import { performanceMonitor } from "./performanceMonitor.js";
import { ObjectId } from "mongodb";

class CertificateService {
  constructor() {
    this.collectionName = "certificates";
  }

  isValidEnum(value, allowed) {
    return allowed.includes(String(value || "").trim());
  }

  addYears(date, years) {
    const d = new Date(date);
    const base = new Date(d.getTime());
    base.setFullYear(base.getFullYear() + Number(years));
    return base;
  }

  // Determinar años de validez según tipo de inspección y equipo
  getYearsToExpire({ tipoInspeccion, tipoEquipo }) {
    // Inspección parcial siempre es 1 año
    if (tipoInspeccion === "PARCIAL") return 1;
    // Inspección total depende del tipo de equipo
    if (tipoInspeccion === "TOTAL") {
      if (tipoEquipo === "CT") return 5;  // Calderas: 5 años
      if (tipoEquipo === "TE") return 10; // Tanques: 10 años
    }
    return null;
  }

  // Calcular fecha de vencimiento y estado del certificado
  computeExpiry(certificate) {
    const { tipoEquipo, tipoInspeccion, fechaCargue, status } = certificate;
    
    // Fecha base para cálculo (fecha de carga)
    const baseDate = fechaCargue ? new Date(fechaCargue) : null;
    const years = this.getYearsToExpire({ tipoInspeccion, tipoEquipo });

    // Si no hay fecha base o no se puede determinar años, retornar valores nulos
    if (!baseDate || !years) {
      return {
        dueDate: null,
        daysLeft: null,
        isExpiringSoon: false,
        computedStatus: status || null,
      };
    }

    // Calcular fecha de vencimiento sumando años a la fecha base
    const due = this.addYears(baseDate, years);
    const now = new Date();
    const msLeft = due.getTime() - now.getTime();
    const daysLeft = Math.floor(msLeft / 86400000); // Convertir milisegundos a días

    // Determinar estado según si está renovado o ha vencido
    const isRenewed = String(status || "").toUpperCase() === "RENOVADO";
    let computedStatus = status || "ACTIVO";
    if (!isRenewed) {
      computedStatus = now > due ? "VENCIDO" : "ACTIVO";
    }

    return {
      dueDate: due.toISOString(),
      daysLeft,
      isExpiringSoon: computedStatus === "ACTIVO" && daysLeft >= 0 && daysLeft <= 15, // Alerta 15 días antes
      computedStatus,
    };
  }


  
  async getAllCertificates() {
    try {
      performanceMonitor.trackDbQuery();
      return await cacheService.getOrSet(
        "all_certificates",
        async () => {
          const db = await connect();
          const certs = await db
            .collection("certificates")
            .find({})
            .sort({ numCert: 1 })
            .toArray();

          
          return certs.map(certificate => this.normalizeCertificate(certificate));
        },
        5 * 60 * 1000
      );
    } catch (error) {
      logger.error("Failed to get certificates", error);
      throw createError("Error obteniendo certificados", 500);
    }
  }

  /**
   * Get certificates filtered by user role.
   * ADMIN: returns all certificates.
   * USER: returns only certificates matching user's empresa AND where user is assigned.
   */
  async getCertificatesForUser({ role, username, empresa }) {
    try {
      performanceMonitor.trackDbQuery();
      const normalizedRole = String(role || "").toUpperCase();

      // ADMIN sees all certificates
      if (normalizedRole === "ADMIN") {
        return this.getAllCertificates();
      }

      // USER sees only their authorized certificates (empresa + assignedUsers)
      const cacheKey = `certs_user_${username}_${empresa}`;
      return await cacheService.getOrSet(
        cacheKey,
        async () => {
          const db = await connect();
          const certs = await db
            .collection("certificates")
            .find({
              empresa: empresa,
              assignedUsers: username
            })
            .sort({ numCert: 1 })
            .toArray();

          return certs.map(certificate => this.normalizeCertificate(certificate));
        },
        5 * 60 * 1000
      );
    } catch (error) {
      logger.error("Failed to get certificates for user", { username, empresa, error });
      throw createError("Error obteniendo certificados", 500);
    }
  }

  
  async createCertificate(certificateData, files) {
    try {
      const {
        numCert,
        serial,
        fechaCargue,
        empresa,
        assignedUsers,
        resultado = "CUMPLE",
        tipoEquipo,
        tipoInspeccion,
      } = certificateData;

      
      const validatedData = this.validateCertificateData({
        numCert,
        serial,
        empresa,
        assignedUsers,
        tipoEquipo,
        tipoInspeccion,
      });

      
      await userService.validateUsersExist(validatedData.assignedUsers, validatedData.empresa);

      
      const meta = {
        Usuario: validatedData.assignedUsers.join(","),
        NumCert: String(validatedData.numCert),
        Serial: String(validatedData.serial),
      };

      // Usar nuevo flujo con árbol de carpetas
      const uploadResult = await driveService.uploadCertificateFiles(
        files,
        meta,
        validatedData.empresa,
        validatedData.numCert,
        validatedData.serial
      );

      // Extraer storage para persistencia
      const storage = uploadResult?._storage || null;
      delete uploadResult?._storage;

      const links = {
        informes: "#",
        certificados: "#",
        anexos: "#",
        driveFolder: "#",
        // Mantener formatos para compatibilidad legacy
        formatos: "#",
        ...(uploadResult || {}),
      };

      const db = await connect();
      
      const document = {
        numCert: Number(validatedData.numCert),
        serial: validatedData.serial,
        fechaCargue: new Date(fechaCargue || new Date()),
        resultado: sanitizeString(resultado),
        empresa: sanitizeString(validatedData.empresa),
        assignedUsers: validatedData.assignedUsers,
        tipoEquipo: validatedData.tipoEquipo,
        tipoInspeccion: validatedData.tipoInspeccion,
        status: "ACTIVO",
        renewedAt: null,
        links,
        // Guardar storage de Drive para futuras operaciones
        storage: storage || null,
        createdAt: new Date()
      };

      const computed = this.computeExpiry(document);
      if (computed?.computedStatus) document.status = computed.computedStatus;


      
      const result = await db.collection("certificates").insertOne(document);

      logger.info("Certificate created", {
        id: result.insertedId,
        numCert: validatedData.numCert,
        empresa: validatedData.empresa,
        hasStorage: !!storage
      });

      // Clear all certificate caches (global and user-scoped)
      cacheService.clear("all_certificates");
      cacheService.clearPrefix("certs_user_");

      return {
        id: result.insertedId.toString(),
        ...document
      };
    } catch (error) {
      if (error.statusCode) throw error;

      logger.error("Failed to create certificate", error);
      throw createError("Error creando certificado", 500);
    }
  }

  async updateCertificate(id, updateData, files) {
    try {
      const _id = new ObjectId(id);
      const db = await connect();

      const existing = await db.collection("certificates").findOne({ _id });
      if (!existing) {
        throw createError("No existe el certificado", 404);
      }

      const updates = this.buildCertificateUpdates(existing, updateData);

      if (updates.assignedUsers && updates.empresa) {
        await userService.validateUsersExist(updates.assignedUsers, updates.empresa);
      }

      const meta = {
        Usuario: (updates.assignedUsers || existing.assignedUsers).join(","),
        NumCert: String(updates.numCert || existing.numCert),
        Serial: String(updates.serial || existing.serial),
      };

      if (files && Object.keys(files).length > 0) {
        const newLinks = await this.updateCertificateFiles(
          files,
          meta,
          updates,
          existing,
          updateData
        );

        // Extraer storage si viene incluido
        const newStorage = newLinks?._storage;
        delete newLinks?._storage;

        const cleanedLinks = Object.fromEntries(
          Object.entries(newLinks || {}).filter(([, v]) => v && v !== "#")
        );

        if (Object.keys(cleanedLinks).length > 0) {
          updates.links = { ...existing.links, ...cleanedLinks };
        }

        // Actualizar storage si se creó
        if (newStorage && !existing.storage?.rootFolderId) {
          updates.storage = newStorage;
        }
      }

      
      const effective = { ...existing, ...updates };
      const computed = this.computeExpiry(effective);

      if (String(effective.status || "").toUpperCase() !== "RENOVADO" && computed?.computedStatus) {
        updates.status = computed.computedStatus;
      }

      await db.collection("certificates").updateOne({ _id }, { $set: updates });

      const updated = await db.collection("certificates").findOne({ _id });
      const normalizedCertificate = this.normalizeCertificate(updated);

      // Clear all certificate caches (global and user-scoped)
      cacheService.clear("all_certificates");
      cacheService.clearPrefix("certs_user_");

      logger.info("Certificate updated", { id, numCert: normalizedCertificate.numCert });

      return normalizedCertificate;
    } catch (error) {
      if (error.statusCode) throw error;

      logger.error("Failed to update certificate", error);
      throw createError("Error actualizando certificado", 500);
    }
  }

  /**
   * Delete certificates by MongoDB _id (preferred) or legacy tuple match.
   * @param {Array} items - Array of { id } or { empresa, numCert, serial }
   */
  async deleteCertificates(items) {
    try {
      if (!Array.isArray(items) || items.length === 0) {
        throw createError("Lista vacía", 400);
      }

      const db = await connect();
      const validHex = /^[a-fA-F0-9]{24}$/;

      // Separate ID-based and tuple-based items
      const idItems = items.filter(c => c.id && validHex.test(c.id));
      const tupleItems = items.filter(c => !c.id && c.empresa && c.numCert && c.serial);

      const conditions = [];

      // Preferred: delete by immutable _id
      if (idItems.length > 0) {
        const objectIds = idItems.map(c => new ObjectId(c.id));
        conditions.push({ _id: { $in: objectIds } });
      }

      // Legacy fallback: delete by tuple (empresa, numCert, serial)
      // WARNING: This can match multiple records if duplicates exist
      if (tupleItems.length > 0) {
        logger.warn("Using legacy tuple-based delete", { count: tupleItems.length });
        conditions.push({
          $or: tupleItems.map(c => ({
            empresa: sanitizeString(c.empresa),
            numCert: Number(c.numCert),
            serial: sanitizeString(c.serial),
          })),
        });
      }

      if (conditions.length === 0) {
        throw createError("No se proporcionaron items válidos para eliminar", 400);
      }

      const query = conditions.length === 1 ? conditions[0] : { $or: conditions };
      const result = await db.collection("certificates").deleteMany(query);

      // Clear all certificate caches (global and user-scoped)
      cacheService.clear("all_certificates");
      cacheService.clearPrefix("certs_user_");

      logger.info("Certificates deleted", { 
        count: result.deletedCount,
        byId: idItems.length,
        byTuple: tupleItems.length
      });
      return { ok: true, deleted: result.deletedCount };
    } catch (error) {
      if (error.statusCode) throw error;

      logger.error("Failed to delete certificates", error);
      throw createError("Error eliminando certificados", 500);
    }
  }

  
  validateCertificateData({ numCert, serial, empresa, assignedUsers, tipoEquipo, tipoInspeccion }) {
    if (!numCert || !serial || !empresa || !assignedUsers || !tipoEquipo || !tipoInspeccion) {
      throw createError(
        "Campos requeridos: numCert, serial, empresa, assignedUsers, tipoEquipo, tipoInspeccion",
        400
      );
    }

    const te = String(tipoEquipo).trim().toUpperCase();
    const ti = String(tipoInspeccion).trim().toUpperCase();

    const validEquipos = ["TE", "CT"];
    const validInspecciones = ["PARCIAL", "TOTAL"];

    if (!this.isValidEnum(te, validEquipos)) {
      throw createError("tipoEquipo inválido. Usa TE o CT.", 400);
    }
    if (!this.isValidEnum(ti, validInspecciones)) {
      throw createError("tipoInspeccion inválido. Usa PARCIAL o TOTAL.", 400);
    }

    return {
      numCert: Number(numCert),
      serial: sanitizeString(serial),
      empresa: sanitizeString(empresa),
      assignedUsers: parseUserList(assignedUsers),
      tipoEquipo: te,
      tipoInspeccion: ti,
    };
  }


  
  buildCertificateUpdates(existing, updateData) {
    const updates = {};
    const validEquipos = ["TE", "CT"];
    const validInspecciones = ["PARCIAL", "TOTAL"];

    const fieldProcessors = {
      numCert: (value) => Number(value),
      fechaCargue: (value) => new Date(value),
      tipoEquipo: (value) => String(value).trim().toUpperCase(),
      tipoInspeccion: (value) => String(value).trim().toUpperCase(),
      assignedUsers: (value) => parseUserList(value),
      default: (value) => sanitizeString(value)
    };

    const allowedFields = [
      "numCert", "serial", "fechaCargue", "empresa", "assignedUsers", "resultado",
      "tipoEquipo", "tipoInspeccion", "status"
    ];

    for (const field of allowedFields) {
      if (updateData[field] !== undefined) {
        const processor = fieldProcessors[field] || fieldProcessors.default;
        updates[field] = processor(updateData[field]);
      }
    }

    if (updates.tipoEquipo && !this.isValidEnum(updates.tipoEquipo, validEquipos)) {
      throw createError("tipoEquipo inválido. Usa TE o CT.", 400);
    }
    if (updates.tipoInspeccion && !this.isValidEnum(updates.tipoInspeccion, validInspecciones)) {
      throw createError("tipoInspeccion inválido. Usa PARCIAL o TOTAL.", 400);
    }

    if (updateData.renovado !== undefined) {
      const markRenewed = String(updateData.renovado) === "true" || updateData.renovado === true;

      if (markRenewed) {
        updates.status = "RENOVADO";
        if (!existing.renewedAt) updates.renewedAt = new Date();
      } else {
        updates.renewedAt = null;
        updates.status = "ACTIVO";
      }
    }

    return updates;
  }

  async updateCertificateFiles(files, meta, updates, existing, updateData) {
    const effectiveEmpresa = sanitizeString(updates.empresa || existing.empresa);
    const effectiveNumCert = updates.numCert || existing.numCert;
    const effectiveSerial = updates.serial || existing.serial;
    
    // Obtener o crear storage
    let storage = existing.storage;
    if (!storage?.rootFolderId) {
      storage = await driveService.ensureCertificateFolderTree(effectiveNumCert);
    }

    const results = {};
    const { pickFirst } = await import("./utils.js");

    // Configuración de archivos con manejo de reemplazo
    const fileConfigs = [
      { fileKey: "informes", prefix: "INF", linkKey: "informes" },
      { fileKey: "certificados", prefix: "CERT", linkKey: "certificados" },
      { fileKey: "anexos", prefix: "ANEXOS", linkKey: "anexos" },
      // Mantener formatos para legacy
      { fileKey: "formatos", prefix: "FOR", linkKey: "formatos" },
    ];

    for (const { fileKey, prefix, linkKey } of fileConfigs) {
      const file = pickFirst(files[fileKey]);
      if (!file) continue;

      // Si existe un archivo previo, moverlo a obsoletos
      const existingLink = existing.links?.[linkKey];
      
      try {
        const newLink = await driveService.replaceFile(
          existingLink,
          file,
          prefix,
          effectiveEmpresa,
          effectiveNumCert,
          effectiveSerial,
          storage
        );
        results[linkKey] = newLink;
      } catch (error) {
        logger.error(`Failed to replace ${prefix} file`, error);
        throw error;
      }
    }

    // Agregar driveFolder si no existe
    if (!existing.links?.driveFolder || existing.links.driveFolder === "#") {
      results.driveFolder = storage.rootFolderLink || 
        `https://drive.google.com/drive/folders/${storage.rootFolderId}`;
    }

    // Retornar también storage actualizado
    results._storage = storage;

    return results;
  }

  
  normalizeCertificate(certificate) {
    const exp = this.computeExpiry(certificate);

    return {
      id: certificate._id?.toString?.() || certificate.id,
      numCert: certificate.numCert,
      serial: certificate.serial,
      fechaCargue: new Date(certificate.fechaCargue).toISOString(),
      resultado: certificate.resultado,
      empresa: sanitizeString(certificate.empresa),
      assignedUsers: certificate.assignedUsers,
      tipoEquipo: certificate.tipoEquipo || null,
      tipoInspeccion: certificate.tipoInspeccion || null,

      
      status: exp?.computedStatus || certificate.status || "ACTIVO",

      renewedAt: certificate.renewedAt ? new Date(certificate.renewedAt).toISOString() : null,

      
      dueDate: exp?.dueDate || null,
      daysLeft: exp?.daysLeft ?? null,
      isExpiringSoon: !!exp?.isExpiringSoon,

      links: certificate.links || { informes: "#", formatos: "#", certificados: "#", anexos: "#", driveFolder: "#" },
    };
  }

}


export const certificateService = new CertificateService();