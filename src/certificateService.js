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
        resultado = "CUMPLE" // Resultado por defecto
      } = certificateData;

      // Valida datos básicos del certificado
      const validatedData = this.validateCertificateData({
        numCert,
        serial,
        empresa,
        assignedUsers
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
      const links = await driveService.uploadCertificateFiles(
        files,
        meta,
        validatedData.empresa,
        validatedData.numCert,
        validatedData.serial
      );

      const db = await connect();
      // Prepara documento para inserción en base de datos
      const document = {
        numCert: Number(validatedData.numCert),
        serial: validatedData.serial,
        fechaCargue: new Date(fechaCargue || new Date()),
        resultado: sanitizeString(resultado),
        empresa: sanitizeString(validatedData.empresa),
        assignedUsers: validatedData.assignedUsers,
        links, // Enlaces a archivos en Drive
        createdAt: new Date()
      };

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

      if (Object.keys(files).length > 0) {
        const newLinks = await this.updateCertificateFiles(
          files,
          meta,
          updates,
          existing,
          updateData
        );
        updates.links = { ...existing.links, ...newLinks };
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
  validateCertificateData({ numCert, serial, empresa, assignedUsers }) {
    if (!numCert || !serial || !empresa || !assignedUsers) {
      throw createError(
        "Campos requeridos: numCert, serial, empresa, assignedUsers",
        400
      );
    }

    return {
      numCert: Number(numCert),                    // Convierte a número
      serial: sanitizeString(serial),              // Limpia string
      empresa: sanitizeString(empresa),            // Limpia string
      assignedUsers: parseUserList(assignedUsers)  // Convierte a array consistente
    };
  }

  // Construye objeto de actualizaciones permitidas para certificados
  buildCertificateUpdates(existing, updateData) {
    const updates = {};
    
    // Campos que se pueden actualizar
    const allowedFields = ["numCert", "serial", "fechaCargue", "empresa", "assignedUsers", "resultado"];
    
    allowedFields.forEach(field => {
      if (updateData[field] !== undefined) {
        if (field === "numCert") {
          updates[field] = Number(updateData[field]); // Convierte a número
        } else if (field === "fechaCargue") {
          updates[field] = new Date(updateData[field]); // Convierte a Date
        } else if (field === "assignedUsers") {
          updates[field] = parseUserList(updateData[field]); // Convierte a array
        } else {
          updates[field] = sanitizeString(updateData[field]); // Limpia string
        }
      }
    });

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
    return {
      id: certificate._id?.toString?.() || certificate.id,      // ID como string
      numCert: certificate.numCert,                              // Número de certificado
      serial: certificate.serial,                                  // Número de serie
      fechaCargue: new Date(certificate.fechaCargue).toISOString(), // Fecha en formato ISO
      resultado: certificate.resultado,                              // Resultado
      empresa: sanitizeString(certificate.empresa),                // Empresa limpiada
      assignedUsers: certificate.assignedUsers,                     // Usuarios asignados
      links: certificate.links || { informes: "#", formatos: "#", certificados: "#" }, // Enlaces
    };
  }
}

// Exporta instancia única del servicio (singleton)
export const certificateService = new CertificateService();