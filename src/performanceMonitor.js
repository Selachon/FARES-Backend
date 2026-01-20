import { logger } from "./utils.js";
import { performance } from "perf_hooks";

// Servicio para monitoreo de rendimiento de la aplicación
class PerformanceMonitor {
  constructor() {
    this.metrics = {
      requests: new Map(),      // Contador de requests por ruta
      responseTimes: [],        // Array de tiempos de respuesta
      errorCounts: new Map(),   // Contador de errores por tipo
      dbQueries: 0,           // Contador de consultas a BD
      driveOperations: 0       // Contador de operaciones Drive
    };
  }

  // Inicia medición de tiempo para una request
  startRequest(req) {
    const key = `${req.method}:${req.route?.path || req.url}`;
    this.metrics.requests.set(key, (this.metrics.requests.get(key) || 0) + 1);
    return performance.now(); // Retorna tiempo de inicio
  }

  // Finaliza medición y registra duración
  endRequest(req, startTime) {
    const duration = performance.now() - startTime; // Calcula duración
    this.metrics.responseTimes.push(duration);
    
    // Mantiene solo los últimos 500 tiempos para no consumir mucha memoria
    if (this.metrics.responseTimes.length > 1000) {
      this.metrics.responseTimes = this.metrics.responseTimes.slice(-500);
    }
  }

  // Registra error para métricas
  trackError(error, req) {
    const key = error.code || "UNKNOWN_ERROR";
    this.metrics.errorCounts.set(key, (this.metrics.errorCounts.get(key) || 0) + 1);
    
    logger.error("Performance metric: error", {
      error: error.message,
      code: error.code,
      route: `${req.method}:${req.route?.path || req.url}`
    });
  }

  // Incrementa contador de consultas a base de datos
  trackDbQuery() {
    this.metrics.dbQueries++;
  }

  // Incrementa contador de operaciones de Google Drive
  trackDriveOperation() {
    this.metrics.driveOperations++;
  }

  // Genera reporte de métricas completo
  getMetrics() {
    const responseTimes = this.metrics.responseTimes;
    
    // Calcula tiempo promedio de respuesta
    const avgResponseTime = responseTimes.length > 0 
      ? responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length 
      : 0;
    
    // Calcula tiempo máximo de respuesta
    const maxResponseTime = responseTimes.length > 0 
      ? Math.max(...responseTimes) 
      : 0;
    
    // Calcula percentil 95 de tiempo de respuesta
    const p95ResponseTime = responseTimes.length > 0
      ? responseTimes.sort((a, b) => a - b)[Math.floor(responseTimes.length * 0.95)]
      : 0;

    // Retorna objeto con todas las métricas del sistema
    return {
      uptime: process.uptime(),                                   // Tiempo corriendo
      memory: process.memoryUsage(),                               // Uso de memoria
      requests: Object.fromEntries(this.metrics.requests),          // Conteo de requests
      responseTime: {
        average: Math.round(avgResponseTime),    // Promedio en ms
        max: Math.round(maxResponseTime),        // Máximo en ms
        p95: Math.round(p95ResponseTime)        // Percentil 95 en ms
      },
      errors: Object.fromEntries(this.metrics.errorCounts),         // Conteo de errores
      operations: {
        dbQueries: this.metrics.dbQueries,          // Consultas a BD
        driveOperations: this.metrics.driveOperations  // Operaciones Drive
      }
    };
  }

  // Reinicia todas las métricas a cero
  reset() {
    this.metrics.requests.clear();
    this.metrics.responseTimes = [];
    this.metrics.errorCounts.clear();
    this.metrics.dbQueries = 0;
    this.metrics.driveOperations = 0;
  }
}

// Exporta instancia única del servicio (singleton)
export const performanceMonitor = new PerformanceMonitor();