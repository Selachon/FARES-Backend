// Archivo de middlewares de Express
// Contiene middlewares para CORS, logging, autorización, manejo de errores y health checks
import { config, validateConfig } from "./config.js";
import { logger } from "./utils.js";
import { performanceMonitor } from "./performanceMonitor.js";
import jwt from "jsonwebtoken";

// Validar configuración al cargar el módulo
validateConfig();

// Middleware personalizado para validación de CORS
// Complementa al middleware CORS estándar con validación adicional y logging
export const corsMiddleware = (req, res, next) => {
  const origin = req.headers.origin;
  
  // Permitir solicitudes sin origin (ej: herramientas API, Postman)
  // o si el origin está en la lista de permitidos
  if (!origin || config.cors.allowedOrigins.includes(origin)) {
    return next();
  }
  
  // En desarrollo local, registrar solicitudes bloqueadas para debugging
  if (config.isLocal) {
    logger.warn("[CORS][BLOCKED]", { origin, method: req.method, url: req.url });
    logger.debug("[CORS][ALLOWED]", { origins: config.cors.allowedOrigins });
  }
  
  next();
};

// Middleware para logging de peticiones HTTP
// Registra información detallada de cada petición y su tiempo de respuesta
export const requestLogger = (req, res, next) => {
  // Iniciar monitoreo de performance para esta petición
  const startTime = performanceMonitor.startRequest(req);
  
  // Configurar callback para cuando la petición finalice
  res.on("finish", () => {
    // Finalizar monitoreo de performance
    performanceMonitor.endRequest(req, startTime);
    
    // Preparar datos de logging
    const logData = {
      method: req.method,           // Método HTTP (GET, POST, etc.)
      url: req.url,                 // URL de la petición
      status: res.statusCode,       // Código de respuesta HTTP
      ip: req.ip,                   // IP del cliente
      userAgent: req.get("User-Agent")  // User Agent del cliente
    };
    
    // Logging con diferentes niveles según el código de estado
    if (res.statusCode >= 400) {
      logger.warn("HTTP Request", logData);
    } else {
      logger.info("HTTP Request", logData);
    }
  });
  
  next();
};

// Middleware de autenticación JWT
// Valida el token JWT de la cookie y extrae los datos del usuario
export const authenticate = (req, res, next) => {
  try {
    // Obtener token de la cookie
    const token = req.cookies?.[config.jwt.cookie.name];
    
    if (!token) {
      return res.status(401).json({
        message: "No autenticado",
        code: "UNAUTHORIZED"
      });
    }

    // Verificar y decodificar el token
    const decoded = jwt.verify(token, config.jwt.secret);
    
    // Adjuntar información del usuario al request
    req.user = {
      username: decoded.username,
      role: decoded.role,
      empresa: decoded.empresa
    };
    
    next();
  } catch (error) {
    // Token inválido o expirado
    logger.warn("JWT verification failed", { error: error.message });
    return res.status(401).json({
      message: "Sesión inválida o expirada",
      code: "INVALID_TOKEN"
    });
  }
};

// Middleware de guard para proteger rutas de administrador
// Requiere autenticación JWT con rol ADMIN
export const adminGuard = (req, res, next) => {
  // Primero autenticar
  authenticate(req, res, (err) => {
    if (err) return;
    
    // Verificar rol ADMIN
    if (req.user.role?.toUpperCase() !== "ADMIN") {
      return res.status(403).json({ 
        message: "Solo ADMIN",
        code: "INSUFFICIENT_PERMISSIONS"
      });
    }
    
    next();
  });
};

// Middleware de guard para proteger rutas de usuario
// Requiere autenticación JWT con rol USER
export const userGuard = (req, res, next) => {
  // Primero autenticar
  authenticate(req, res, (err) => {
    if (err) return;
    
    // Verificar rol USER
    if (req.user.role?.toUpperCase() !== "USER") {
      return res.status(403).json({
        message: "Solo USER",
        code: "INSUFFICIENT_PERMISSIONS",
      });
    }
    
    next();
  });
};

// Middleware centralizado de manejo de errores
// Procesa todos los errores de la aplicación y envía respuestas consistentes
export const errorHandler = (error, req, res, next) => {
  // Determinar código de estado (default 500)
  const statusCode = error.statusCode || 500;
  const code = error.code || "INTERNAL_ERROR";

  // Determinar si es error de cliente (4xx) o servidor (5xx)
  const isClientError = statusCode >= 400 && statusCode < 500;

  // Registrar error en monitor de performance
  performanceMonitor.trackError(error, req);

  // Preparar payload de logging con detalles del error y la petición
  const logPayload = {
    error: {
      message: error.message,
      stack: error.stack,
      statusCode,
      code,
    },
    request: {
      method: req.method,
      url: req.url,
      body: req.body ? Object.fromEntries(
        Object.entries(req.body).map(([k, v]) =>
          /password|clave|secret|token/i.test(k) ? [k, "[REDACTED]"] : [k, v]
        )
      ) : undefined,
      params: req.params,
      query: req.query,
    },
  };

  // Logging con nivel apropiado según tipo de error
  if (isClientError) {
    logger.warn("Request warning", logPayload);
  } else {
    logger.error("Request error", logPayload);
  }

  // Determinar mensaje de respuesta (detallado en local, genérico en producción)
  const message = isClientError
    ? error.message
    : (config.isLocal ? error.message : "Error interno del servidor");

  // Enviar respuesta JSON con formato estandarizado
  res.status(statusCode).json({
    message,
    code,
    // Incluir stack trace solo en entorno local
    ...(config.isLocal && { stack: error.stack }),
  });
};

// Middleware para manejar rutas no encontradas (404)
// Debe ser el último middleware de enrutamiento
export const notFoundHandler = (req, res) => {
  res.status(404).json({
    message: "Ruta no encontrada",
    code: "NOT_FOUND"
  });
};

// Middleware de guard para la app móvil offline
// Requiere header x-app-key con clave de API válida
export const appGuard = (req, res, next) => {
  const appKey = req.headers["x-app-key"];
  
  // Verificar clave de API para la app móvil (sin fallback hardcodeado)
  if (!appKey || appKey !== config.security.appApiKey) {
    return res.status(403).json({ 
      message: "Clave de API inválida",
      code: "INVALID_APP_KEY"
    });
  }
  
  next();
};

// Middleware de health check para monitoreo de sistema
// Verifica estado de la aplicación y conexión a base de datos
export const healthMiddleware = async (req, res) => {
  try {
    // Intentar conectar a la base de datos
    const { connect } = await import("./db.js");
    const db = await connect();
    // Realizar ping para verificar conexión activa
    await db.admin().ping();
    
    // Si todo está bien, retornar estado saludable
    res.json({
      status: "healthy",
      timestamp: new Date().toISOString(),
      database: "connected"
    });
  } catch (error) {
    // Si algo falla, registrar error y retornar estado no saludable
    logger.error("Health check failed", error);
    
    res.status(503).json({
      status: "unhealthy",
      timestamp: new Date().toISOString(),
      error: error.message
    });
  }
};