// Servicio de caché en memoria con TTL (Time To Live)
// Implementa un sistema de caché simple para reducir consultas a base de datos
import { connect } from "./db.js";
import { logger } from "./utils.js";

class CacheService {
  constructor() {
    // Map para almacenar los valores en caché
    this.cache = new Map();
    // Map para almacenar tiempos de expiración de cada clave
    this.ttl = new Map();
    // TTL por defecto: 5 minutos en milisegundos
    this.defaultTTL = 5 * 60 * 1000;
    // Límite máximo de entradas en caché (previene crecimiento ilimitado)
    this.maxEntries = 100;
    // Intervalo de limpieza automática: cada 60 segundos
    this.cleanupInterval = setInterval(() => this.cleanup(), 60000);
  }

  // Almacenar un valor en caché con tiempo de vida específico
  set(key, value, ttl = this.defaultTTL) {
    // Si excede límite, limpiar entradas expiradas primero
    if (this.cache.size >= this.maxEntries) {
      this.cleanup();
      // Si aún excede límite, eliminar entrada más antigua
      if (this.cache.size >= this.maxEntries) {
        const oldestKey = this.cache.keys().next().value;
        this.cache.delete(oldestKey);
        this.ttl.delete(oldestKey);
      }
    }
    this.cache.set(key, value);
    this.ttl.set(key, Date.now() + ttl);
  }

  // Obtener un valor de caché, verificando que no haya expirado
  get(key) {
    const expiry = this.ttl.get(key);
    const now = Date.now();
    
    // Si no tiene fecha de expiración o ya expiró, eliminar y retornar null
    if (!expiry || now > expiry) {
      this.cache.delete(key);
      this.ttl.delete(key);
      return null;
    }
    
    // Retornar el valor si está vigente
    return this.cache.get(key);
  }

  clear(key) {
    if (key) {
      this.cache.delete(key);
      this.ttl.delete(key);
    } else {
      this.cache.clear();
      this.ttl.clear();
    }
  }

  async getOrSet(key, fetchFn, ttl = this.defaultTTL) {
    let value = this.get(key);
    
    if (value === null) {
      value = await fetchFn();
      this.set(key, value, ttl);
    }
    
    return value;
  }

  cleanup() {
    const now = Date.now();
    for (const [key, expiry] of this.ttl.entries()) {
      if (now > expiry) {
        this.cache.delete(key);
        this.ttl.delete(key);
      }
    }
  }

  destroy() {
    clearInterval(this.cleanupInterval);
  }
}
export const cacheService = new CacheService();