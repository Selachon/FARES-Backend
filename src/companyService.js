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
