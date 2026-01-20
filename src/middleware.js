import { config, validateConfig } from "./config.js";
import { logger } from "./utils.js";
import { performanceMonitor } from "./performanceMonitor.js";

// Valida que todas las variables de entorno requeridas estén presentes
validateConfig();

// Middleware para control de CORS (Cross-Origin Resource Sharing)
export const corsMiddleware = (req, res, next) => {
  const origin = req.headers.origin; // Origen de la solicitud
  
  // Permite la solicitud si no hay origen o está en la lista de permitidos
  if (!origin || config.cors.allowedOrigins.includes(origin)) {
    return next();
  }
  
  // En desarrollo, registra intentos bloqueados para debugging
  if (config.isLocal) {
    logger.warn("[CORS][BLOCKED]", { origin, method: req.method, url: req.url });
    logger.debug("[CORS][ALLOWED]", { origins: config.cors.allowedOrigins });
  }
  
  next(); // Continúa con el siguiente middleware
};

// Middleware para registrar y medir tiempo de respuesta de cada petición
export const requestLogger = (req, res, next) => {
  const startTime = performanceMonitor.startRequest(req); // Inicia medición
  
  // Se ejecuta cuando la respuesta termina de enviarse
  res.on("finish", () => {
    performanceMonitor.endRequest(req, startTime); // Finaliza medición
    
    const logData = {
      method: req.method,      // Método HTTP (GET, POST, etc.)
      url: req.url,          // URL solicitada
      status: res.statusCode,  // Código de estado de respuesta
      ip: req.ip,            // IP del cliente
      userAgent: req.get("User-Agent") // Navegador del cliente
    };
    
    // Registra como advertencia si hay error, como información si es exitoso
    if (res.statusCode >= 400) {
      logger.warn("HTTP Request", logData);
    } else {
      logger.info("HTTP Request", logData);
    }
  });
  
  next(); // Continúa con el siguiente middleware
};

// Middleware de seguridad: restringe acceso a administradores
export const adminGuard = (req, res, next) => {
  const role = req.headers["x-role"]; // Obtiene rol desde header
  
  // Verifica si el rol es ADMIN
  if (!role || role.toUpperCase() !== "ADMIN") {
    return res.status(403).json({ 
      message: "Solo ADMIN",
      code: "INSUFFICIENT_PERMISSIONS" // Código para el cliente
    });
  }
  
  next(); // Permite continuar si es administrador
};

// Middleware centralizado de manejo de errores
export const errorHandler = (error, req, res, next) => {
  // Registra el error en el monitor de rendimiento
  performanceMonitor.trackError(error, req);
  
  // Registra información detallada del error para debugging
  logger.error("Request error", {
    error: {
      message: error.message,
      stack: error.stack,
      statusCode: error.statusCode,
      code: error.code
    },
    request: {
      method: req.method,
      url: req.url,
      body: req.body,
      params: req.params,
      query: req.query
    }
  });
  
  // Determina el código de estado HTTP y código de error
  const statusCode = error.statusCode || 500;
  const code = error.code || "INTERNAL_ERROR";
  
  // En desarrollo muestra el error completo, en producción un mensaje genérico
  const message = config.isLocal ? error.message : "Error interno del servidor";
  
  res.status(statusCode).json({
    message,
    code,
    ...(config.isLocal && { stack: error.stack }) // Stack trace solo en desarrollo
  });
};

// Manejador para rutas no encontradas (404)
export const notFoundHandler = (req, res) => {
  res.status(404).json({
    message: "Ruta no encontrada",
    code: "NOT_FOUND"
  });
};

// Middleware para checks de salud del sistema
export const healthMiddleware = async (req, res) => {
  try {
    // Prueba conexión a la base de datos
    const db = await import("./db.js").then(m => m.connect());
    await db.admin().ping(); // Verifica que la BD responda
    
    // Retorna estado saludable con métricas básicas
    res.json({
      status: "healthy",
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),                     // Tiempo corriendo en segundos
      memory: process.memoryUsage(),                // Uso de memoria
      database: "connected"                        // Estado de la BD
    });
  } catch (error) {
    logger.error("Health check failed", error);
    
    // Retorna estado no saludable con detalles del error
    res.status(503).json({
      status: "unhealthy",
      timestamp: new Date().toISOString(),
      error: error.message
    });
  }
};