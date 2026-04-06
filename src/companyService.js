// Servicio de gestión de empresas
// Permite consultar y crear empresas para el portal
import { connect } from "./db.js";
import { cacheService } from "./cacheService.js";
import { performanceMonitor } from "./performanceMonitor.js";
import { logger, sanitizeString, createError } from "./utils.js";

class CompanyService {
  constructor() {
    this.collectionName = "companies";
  }

  normalizeName(name) {
    return sanitizeString(name).toUpperCase();
  }

  normalizeDetail(value) {
    return sanitizeString(value || "");
  }

  getDocTimestamp(doc) {
    const ts = doc?.updatedAt || doc?.createdAt;
    if (!ts) return 0;
    const parsed = new Date(ts).getTime();
    return Number.isFinite(parsed) ? parsed : 0;
  }

  companyMatchQuery(name) {
    const escaped = String(name || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return { $regex: `^${escaped}$`, $options: "i" };
  }

  extractClientData(doc) {
    const data = doc?.inspeccionCompleta?.datosCliente || {};
    return {
      nit: this.normalizeDetail(data.nit),
      direccion: this.normalizeDetail(data.direccion),
      ciudad: this.normalizeDetail(data.ciudad),
      telefono: this.normalizeDetail(data.telefono),
    };
  }

  mergeProfile(base, inferred) {
    return {
      name: base.name,
      nit: base.nit || inferred.nit || "",
      direccion: base.direccion || inferred.direccion || "",
      ciudad: base.ciudad || inferred.ciudad || "",
      telefono: base.telefono || inferred.telefono || "",
    };
  }

  async getCompanyProfile(name) {
    try {
      const normalized = this.normalizeName(name);
      if (!normalized) {
        throw createError("Nombre de empresa requerido", 400, "MISSING_COMPANY");
      }

      performanceMonitor.trackDbQuery();
      const db = await connect();
      const companies = db.collection(this.collectionName);

      const companyDoc = await companies.findOne({ name: normalized });

      const base = {
        name: normalized,
        nit: this.normalizeDetail(companyDoc?.nit),
        direccion: this.normalizeDetail(companyDoc?.direccion),
        ciudad: this.normalizeDetail(companyDoc?.ciudad),
        telefono: this.normalizeDetail(companyDoc?.telefono),
      };

      const projection = {
        projection: {
          inspeccionCompleta: 1,
          createdAt: 1,
          updatedAt: 1,
        },
        sort: { updatedAt: -1, createdAt: -1 },
      };

      const [latestCertificate, latestDraft] = await Promise.all([
        db
          .collection("certificates")
          .findOne(
            {
              empresa: this.companyMatchQuery(normalized),
              "inspeccionCompleta.datosCliente": { $exists: true },
            },
            projection,
          ),
        db
          .collection("drafts")
          .findOne(
            {
              empresa: this.companyMatchQuery(normalized),
              "inspeccionCompleta.datosCliente": { $exists: true },
            },
            projection,
          ),
      ]);

      const candidates = [latestCertificate, latestDraft].filter(Boolean);
      const latest = candidates.sort(
        (a, b) => this.getDocTimestamp(b) - this.getDocTimestamp(a),
      )[0];

      const inferred = latest ? this.extractClientData(latest) : {};
      return this.mergeProfile(base, inferred);
    } catch (error) {
      if (error.statusCode) throw error;
      logger.error("Failed to get company profile", error);
      throw createError("Error obteniendo perfil de empresa", 500);
    }
  }

  async getAllCompanyProfiles() {
    try {
      const names = await this.getAllCompanies();
      if (!Array.isArray(names) || names.length === 0) return [];

      const profiles = await Promise.all(
        names.map(async (name) => {
          try {
            return await this.getCompanyProfile(name);
          } catch (_) {
            return { name };
          }
        }),
      );

      return profiles.sort((a, b) => a.name.localeCompare(b.name, "es"));
    } catch (error) {
      if (error.statusCode) throw error;
      logger.error("Failed to get all company profiles", error);
      throw createError("Error obteniendo perfiles de empresa", 500);
    }
  }

  async getAllCompanies() {
    try {
      performanceMonitor.trackDbQuery();

      return await cacheService.getOrSet(
        "all_companies",
        async () => {
          const db = await connect();
          const collection = db.collection(this.collectionName);

          const existing = await collection.find({}).toArray();
          const existingNames = existing
            .map((c) => this.normalizeName(c.name))
            .filter(Boolean);
          const existingSet = new Set(existingNames);

          const [userCompanies, certCompanies] = await Promise.all([
            db.collection("users").distinct("empresa"),
            db.collection("certificates").distinct("empresa"),
          ]);

          const derived = [...userCompanies, ...certCompanies]
            .map((name) => this.normalizeName(name))
            .filter(Boolean);
          const derivedSet = new Set(derived);

          const missing = Array.from(derivedSet).filter(
            (name) => !existingSet.has(name),
          );

          if (missing.length) {
            const now = new Date();
            await collection.insertMany(
              missing.map((name) => ({ name, createdAt: now })),
            );
            missing.forEach((name) => existingSet.add(name));
          }

          const allNames = Array.from(new Set([...existingSet, ...derivedSet]));
          return allNames.sort((a, b) => a.localeCompare(b, "es"));
        },
        5 * 60 * 1000,
      );
    } catch (error) {
      logger.error("Failed to get companies", error);
      throw createError("Error obteniendo empresas", 500);
    }
  }

  async createCompany(name) {
    try {
      const normalized = this.normalizeName(name);
      if (!normalized) {
        throw createError("Nombre de empresa requerido", 400, "MISSING_COMPANY");
      }

      performanceMonitor.trackDbQuery();
      const db = await connect();

      await db.collection(this.collectionName).updateOne(
        { name: normalized },
        { $setOnInsert: { name: normalized, createdAt: new Date() } },
        { upsert: true },
      );

      cacheService.clear("all_companies");

      return { name: normalized };
    } catch (error) {
      if (error.statusCode) throw error;

      logger.error("Failed to create company", error);
      throw createError("Error creando empresa", 500);
    }
  }
}

export const companyService = new CompanyService();
