// Monitor de rendimiento del sistema
// Registra métricas de peticiones, tiempos de respuesta, errores y operaciones
import { logger } from "./utils.js";
import { performance } from "perf_hooks";

class PerformanceMonitor {
  constructor() {
    // Inicializar estructura de métricas
    this.metrics = {
      requests: new Map(),       // Contador de peticiones por ruta
      responseTimes: [],         // Array de tiempos de respuesta
      errorCounts: new Map(),    // Contador de errores por tipo
      dbQueries: 0,              // Contador de consultas a BD
      driveOperations: 0         // Contador de operaciones con Drive
    };
  }

  startRequest(req) {
    const key = `${req.method}:${req.route?.path || req.url}`;
    this.metrics.requests.set(key, (this.metrics.requests.get(key) || 0) + 1);
    return performance.now();
  }

  endRequest(req, startTime) {
    const duration = performance.now() - startTime;
    this.metrics.responseTimes.push(duration);
    
    if (this.metrics.responseTimes.length > 1000) {
      this.metrics.responseTimes = this.metrics.responseTimes.slice(-500);
    }
  }
  // Registrar ocurrencia de un error en las métricas
  trackError(error, req) {
    const key = error.code || "UNKNOWN_ERROR";
    this.metrics.errorCounts.set(key, (this.metrics.errorCounts.get(key) || 0) + 1);
    
    // Logging con detalles del error para diagnóstico
    logger.error("Performance metric: error", {
      error: error.message,
      code: error.code,
      route: `${req.method}:${req.route?.path || req.url}`
    });
  }

  
  // Incrementar contador de consultas a base de datos
  trackDbQuery() {
    this.metrics.dbQueries++;
  }

  
  // Incrementar contador de operaciones con Google Drive
  trackDriveOperation() {
    this.metrics.driveOperations++;
  }

  
  getMetrics() {
    const responseTimes = this.metrics.responseTimes;
    const { length } = responseTimes;
    
    const avgResponseTime = length > 0 
      ? responseTimes.reduce((sum, time) => sum + time, 0) / length 
      : 0;
    
    const maxResponseTime = length > 0 
      ? Math.max(...responseTimes) 
      : 0;
    
    const p95ResponseTime = length > 0
      ? responseTimes.sort((a, b) => a - b)[Math.floor(length * 0.95)]
      : 0;

    return {
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      requests: Object.fromEntries(this.metrics.requests),
      responseTime: {
        average: Math.round(avgResponseTime),
        max: Math.round(maxResponseTime),
        p95: Math.round(p95ResponseTime)
      },
      errors: Object.fromEntries(this.metrics.errorCounts),
      operations: {
        dbQueries: this.metrics.dbQueries,
        driveOperations: this.metrics.driveOperations
      }
    };
  }

  
  reset() {
    this.metrics.requests.clear();
    this.metrics.responseTimes = [];
    this.metrics.errorCounts.clear();
    this.metrics.dbQueries = 0;
    this.metrics.driveOperations = 0;
  }
}


export const performanceMonitor = new PerformanceMonitor();