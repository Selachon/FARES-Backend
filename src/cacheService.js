import { connect } from "./db.js";
import { logger } from "./utils.js";

// Servicio de caché en memoria con TTL (Time To Live)
class CacheService {
  constructor() {
    this.cache = new Map();      // Almacena datos en caché
    this.ttl = new Map();        // Almacena tiempos de expiración
    this.defaultTTL = 5 * 60 * 1000; // TTL por defecto: 5 minutos
  }

  // Almacena un valor en caché con tiempo de expiración
  set(key, value, ttl = this.defaultTTL) {
    this.cache.set(key, value);
    this.ttl.set(key, Date.now() + ttl); // Timestamp de expiración
  }

  // Obtiene valor de caché si no ha expirado
  get(key) {
    const expiry = this.ttl.get(key);
    
    // Si no existe o ha expirado, lo elimina y retorna null
    if (!expiry || Date.now() > expiry) {
      this.cache.delete(key);
      this.ttl.delete(key);
      return null;
    }
    
    return this.cache.get(key);
  }

  // Limpia caché (por clave específica o toda la caché)
  clear(key) {
    if (key) {
      // Limpia solo una clave específica
      this.cache.delete(key);
      this.ttl.delete(key);
    } else {
      // Limpia toda la caché
      this.cache.clear();
      this.ttl.clear();
    }
  }

  // Obtiene valor de caché o ejecuta función si no existe/ha expirado
  async getOrSet(key, fetchFn, ttl = this.defaultTTL) {
    let value = this.get(key);
    
    // Si no está en caché o ha expirado, ejecuta función y almacena resultado
    if (value === null) {
      value = await fetchFn(); // Ejecuta función asíncrona
      this.set(key, value, ttl); // Almacena resultado en caché
    }
    
    return value;
  }
}

// Exporta instancia única del servicio (singleton)
export const cacheService = new CacheService();