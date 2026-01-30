import { connect } from "./db.js";
import { logger, parseUserList, createError, sanitizeString } from "./utils.js";
import { driveService } from "./driveService.js";
import { userService } from "./userService.js";
import { cacheService } from "./cacheService.js";
import { performanceMonitor } from "./performanceMonitor.js";
import { ObjectId } from "mongodb";

// Servicio para gestión de certificados del sistema
class CertificateService {
  constructor() {
    this.collectionName = "certificates"; // Nombre de colección en MongoDB
  }

  // --- Vencimiento y status ---

  isValidEnum(value, allowed) {
    return allowed.includes(String(value || "").trim());
  }

  addYears(date, years) {
    const d = new Date(date);
    const base = new Date(d.getTime());
    base.setFullYear(base.getFullYear() + Number(years));
    return base;
  }

  getYearsToExpire({ tipoInspeccion, tipoEquipo }) {
    if (tipoInspeccion === "PARCIAL") return 1;
    if (tipoInspeccion === "TOTAL") {
      if (tipoEquipo === "CT") return 5;
      if (tipoEquipo === "TE") return 10;
    }
    return null;
  }

  computeExpiry(certificate) {
    const tipoEquipo = certificate.tipoEquipo || null;
    const tipoInspeccion = certificate.tipoInspeccion || null;

    const baseDate = certificate.fechaCargue ? new Date(certificate.fechaCargue) : null;
    const years = this.getYearsToExpire({ tipoInspeccion, tipoEquipo });

    if (!baseDate || !years) {
      return {
        dueDate: null,
        daysLeft: null,
        isExpiringSoon: false,
        computedStatus: certificate.status || null,
      };
    }

    const due = this.addYears(baseDate, years);

    // daysLeft: diferencia en días (redondeo hacia abajo)
    const now = new Date();
    const msLeft = due.getTime() - now.getTime();
    const daysLeft = Math.floor(msLeft / (24 * 60 * 60 * 1000));

    // Status calculado (si no está renovado)
    const isRenewed = String(certificate.status || "").toUpperCase() === "RENOVADO";
    let computedStatus = certificate.status || "ACTIVO";
    if (!isRenewed) {
      computedStatus = now > due ? "VENCIDO" : "ACTIVO";
    }

    const isExpiringSoon = computedStatus === "ACTIVO" && daysLeft >= 0 && daysLeft <= 15;

    return {
      dueDate: due.toISOString(),
      daysLeft,
      isExpiringSoon,
      computedStatus,
    };
  }


  // Obtiene todos los certificados (con caché para rendimiento)
  async getAllCertificates() {
    try {
      performanceMonitor.trackDbQuery(); // Registra operación BD para métricas

      // Usa caché para reducir carga en base de datos
      return await cacheService.getOrSet(
        "all_certificates",
        async () => {
          const db = await connect();
          const certs = await db
            .collection("certificates")
            .find({})
            .sort({ numCert: 1 }) // Ordena por número de certificado
            .toArray();

          // Normaliza formato de datos para respuesta consistente
          return certs.map(certificate => this.normalizeCertificate(certificate));
        },
        5 * 60 * 1000 // Cache por 5 minutos
      );
    } catch (error) {
      logger.error("Failed to get certificates", error);
      throw createError("Error obteniendo certificados", 500);
    }
  }

  // Crea nuevo certificado con archivos adjuntos
  async createCertificate(certificateData, files) {
    try {
      const {
        numCert,        // Número de certificado
        serial,         // Número de serie
        fechaCargue,    // Fecha de cargue
        empresa,        // Empresa
        assignedUsers,  // Usuarios asignados
        resultado = "CUMPLE", // Resultado por defecto
        tipoEquipo,        // NUEVO
        tipoInspeccion,     // NUEVO
      } = certificateData;

      // Valida datos básicos del certificado
      const validatedData = this.validateCertificateData({
        numCert,
        serial,
        empresa,
        assignedUsers,
        tipoEquipo,
        tipoInspeccion,
      });

      // Verifica que los usuarios existan y pertenezcan a la empresa
      await userService.validateUsersExist(validatedData.assignedUsers, validatedData.empresa);

      // Prepara metadatos para archivos en Drive
      const meta = {
        Usuario: validatedData.assignedUsers.join(","),
        NumCert: String(validatedData.numCert),
        Serial: String(validatedData.serial),
      };

      // Sube archivos a Google Drive en paralelo
      const uploadedLinks = await driveService.uploadCertificateFiles(
  files,
  meta,
  validatedData.empresa,
  validatedData.numCert,
  validatedData.serial
);

// ✅ Mantén defaults aunque no suban uno o más archivos
const links = {
  informes: "#",
  formatos: "#",
  certificados: "#",
  ...(uploadedLinks || {}),
};

      const db = await connect();
      // Prepara documento para inserción en base de datos
      const document = {
        numCert: Number(validatedData.numCert),
        serial: validatedData.serial,
        fechaCargue: new Date(fechaCargue || new Date()),
        resultado: sanitizeString(resultado),
        empresa: sanitizeString(validatedData.empresa),
        assignedUsers: validatedData.assignedUsers,
        tipoEquipo: validatedData.tipoEquipo,         // NUEVO
        tipoInspeccion: validatedData.tipoInspeccion, // NUEVO
        status: "ACTIVO",                              // NUEVO (luego se recalcula)
        renewedAt: null,                               // NUEVO
        links, // Enlaces a archivos en Drive
        createdAt: new Date()
      };

      const computed = this.computeExpiry(document);
      if (computed?.computedStatus) document.status = computed.computedStatus;


      // Inserta certificado en base de datos
      const result = await db.collection("certificates").insertOne(document);

      logger.info("Certificate created", {
        id: result.insertedId,
        numCert: validatedData.numCert,
        empresa: validatedData.empresa
      });

      // Limpia caché para reflejar nuevo certificado
      cacheService.clear("all_certificates");

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

  // Solo mezcla links "reales" (evita pisar con "#" o null/undefined)
  const cleanedLinks = Object.fromEntries(
    Object.entries(newLinks || {}).filter(([, v]) => v && v !== "#")
  );

  if (Object.keys(cleanedLinks).length > 0) {
    updates.links = { ...existing.links, ...cleanedLinks };
  }
}

      // Calcula status dinámico si no está marcado como RENOVADO
      const effective = { ...existing, ...updates };
      const computed = this.computeExpiry(effective);

      if (String(effective.status || "").toUpperCase() !== "RENOVADO" && computed?.computedStatus) {
        updates.status = computed.computedStatus;
      }

      await db.collection("certificates").updateOne({ _id }, { $set: updates });

      const updated = await db.collection("certificates").findOne({ _id });
      const normalizedCertificate = this.normalizeCertificate(updated);

      cacheService.clear("all_certificates");

      logger.info("Certificate updated", { id, numCert: normalizedCertificate.numCert });

      return normalizedCertificate;
    } catch (error) {
      if (error.statusCode) throw error;

      logger.error("Failed to update certificate", error);
      throw createError("Error actualizando certificado", 500);
    }
  }

  async deleteCertificates(items) {
    try {
      if (!Array.isArray(items) || items.length === 0) {
        throw createError("Lista vacía", 400);
      }

      const db = await connect();
      const result = await db.collection("certificates").deleteMany({
        $or: items.map(c => ({
          empresa: sanitizeString(c.empresa),
          numCert: Number(c.numCert),
          serial: sanitizeString(c.serial),
        })),
      });

      cacheService.clear("all_certificates");

      logger.info("Certificates deleted", { count: result.deletedCount });
      return { ok: true, deleted: result.deletedCount };
    } catch (error) {
      if (error.statusCode) throw error;

      logger.error("Failed to delete certificates", error);
      throw createError("Error eliminando certificados", 500);
    }
  }

  // Valida datos básicos requeridos para certificado
  validateCertificateData({ numCert, serial, empresa, assignedUsers, tipoEquipo, tipoInspeccion }) {
    if (!numCert || !serial || !empresa || !assignedUsers || !tipoEquipo || !tipoInspeccion) {
      throw createError(
        "Campos requeridos: numCert, serial, empresa, assignedUsers, tipoEquipo, tipoInspeccion",
        400
      );
    }

    const te = String(tipoEquipo).trim().toUpperCase();
    const ti = String(tipoInspeccion).trim().toUpperCase();

    if (!this.isValidEnum(te, ["TE", "CT"])) {
      throw createError("tipoEquipo inválido. Usa TE o CT.", 400);
    }
    if (!this.isValidEnum(ti, ["PARCIAL", "TOTAL"])) {
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


  // Construye objeto de actualizaciones permitidas para certificados
  buildCertificateUpdates(existing, updateData) {
    const updates = {};

    // Campos que se pueden actualizar
    const allowedFields = [
      "numCert", "serial", "fechaCargue", "empresa", "assignedUsers", "resultado",
      "tipoEquipo", "tipoInspeccion",
      "status" // lo aceptamos pero lo controlaremos
    ];

    allowedFields.forEach(field => {
      if (updateData[field] !== undefined) {
        if (field === "numCert") {
          updates[field] = Number(updateData[field]); // Convierte a número
        } else if (field === "fechaCargue") {
          updates[field] = new Date(updateData[field]); // Convierte a Date
        } else if (field === "tipoEquipo") {
          updates[field] = String(updateData[field]).trim().toUpperCase();
        } else if (field === "tipoInspeccion") {
          updates[field] = String(updateData[field]).trim().toUpperCase();
        } else if (field === "assignedUsers") {
          updates[field] = parseUserList(updateData[field]); // Convierte a array
        } else {
          updates[field] = sanitizeString(updateData[field]); // Limpia string
        }
      }
    });

    // Normaliza/valida enums si vienen
    if (updates.tipoEquipo && !this.isValidEnum(updates.tipoEquipo, ["TE", "CT"])) {
      throw createError("tipoEquipo inválido. Usa TE o CT.", 400);
    }
    if (updates.tipoInspeccion && !this.isValidEnum(updates.tipoInspeccion, ["PARCIAL", "TOTAL"])) {
      throw createError("tipoInspeccion inválido. Usa PARCIAL o TOTAL.", 400);
    }

    // Renovado: el frontend enviará "renovado" boolean (recomendado)
    if (updateData.renovado !== undefined) {
      const markRenewed =
        String(updateData.renovado) === "true" || updateData.renovado === true;

      if (markRenewed) {
        updates.status = "RENOVADO";
        if (!existing.renewedAt) updates.renewedAt = new Date();
      } else {
        // ✅ Desmarcado: limpiar timestamp y SALIR de RENOVADO
        updates.renewedAt = null;

        // Clave: si venía RENOVADO, lo sacamos de ese estado para que el cálculo aplique
        updates.status = "ACTIVO"; // placeholder; se recalcula en updateCertificate
      }
    }

    return updates;

  }

  async updateCertificateFiles(files, meta, updates, existing, updateData) {
    const effectiveEmpresa = sanitizeString(updates.empresa || existing.empresa);
    const effectiveNumCert = updates.numCert || existing.numCert;
    const effectiveSerial = updates.serial || existing.serial;

    return driveService.uploadCertificateFiles(
      files,
      meta,
      effectiveEmpresa,
      effectiveNumCert,
      effectiveSerial
    );
  }

  // Normaliza formato de certificado para respuesta API consistente
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

      // status "vivo" (cambia con el tiempo si no está renovado)
      status: exp?.computedStatus || certificate.status || "ACTIVO",

      renewedAt: certificate.renewedAt ? new Date(certificate.renewedAt).toISOString() : null,

      // derivados para UI
      dueDate: exp?.dueDate || null,
      daysLeft: exp?.daysLeft ?? null,
      isExpiringSoon: !!exp?.isExpiringSoon,

      links: certificate.links || { informes: "#", formatos: "#", certificados: "#" },
    };
  }

}

// Exporta instancia única del servicio (singleton)
export const certificateService = new CertificateService();