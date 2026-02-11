// Servicio de inventario (sitios de inspeccion)
import { connect } from "./db.js";
import { cacheService } from "./cacheService.js";
import { performanceMonitor } from "./performanceMonitor.js";
import { logger, sanitizeString, createError } from "./utils.js";

class InventoryService {
  constructor() {
    this.sitesCollection = "inventory_sites";
  }

  normalizeName(value) {
    return sanitizeString(value).toUpperCase();
  }

  normalizeAddress(value) {
    return sanitizeString(value);
  }

  normalizeCoord(value) {
    const num = Number(value);
    return Number.isFinite(num) ? num : undefined;
  }

  async getSites() {
    try {
      performanceMonitor.trackDbQuery();
      return await cacheService.getOrSet(
        "inventory_sites",
        async () => {
          const db = await connect();
          const sites = await db
            .collection(this.sitesCollection)
            .find({})
            .sort({ name: 1 })
            .toArray();

          return sites.map((site) => ({
            name: site.name,
            address: site.address || "",
            latitud: site.latitud,
            longitud: site.longitud,
          }));
        },
        5 * 60 * 1000,
      );
    } catch (error) {
      logger.error("Failed to get sites", error);
      throw createError("Error obteniendo ubicaciones", 500);
    }
  }

  async createSite({ name, address, latitud, longitud, source }) {
    try {
      const normalizedName = this.normalizeName(name || address);
      const normalizedAddress = this.normalizeAddress(address);
      const normalizedLat = this.normalizeCoord(latitud);
      const normalizedLng = this.normalizeCoord(longitud);
      const normalizedSource = sanitizeString(source) || "manual";

      if (!normalizedName) {
        throw createError("Nombre de ubicacion requerido", 400);
      }

      performanceMonitor.trackDbQuery();
      const db = await connect();

      const now = new Date();
      await db.collection(this.sitesCollection).updateOne(
        { name: normalizedName },
        {
          $set: {
            address: normalizedAddress,
            latitud: normalizedLat,
            longitud: normalizedLng,
            source: normalizedSource,
            updatedAt: now,
          },
          $setOnInsert: {
            createdAt: now,
          },
        },
        { upsert: true },
      );

      cacheService.clear("inventory_sites");

      return {
        name: normalizedName,
        address: normalizedAddress,
        latitud: normalizedLat,
        longitud: normalizedLng,
      };
    } catch (error) {
      if (error.statusCode) throw error;

      logger.error("Failed to create site", error);
      throw createError("Error creando ubicacion", 500);
    }
  }
}

export const inventoryService = new InventoryService();
