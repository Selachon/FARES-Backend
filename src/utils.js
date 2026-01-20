import { config } from "./config.js";

// Sistema de logging centralizado para toda la aplicación
export const logger = {
  // Registra mensajes informativos (operaciones exitosas, estado general)
  info: (message, meta = {}) => {
    console.log(`[INFO] ${new Date().toISOString()} ${message}`, meta);
  },
  
  // Registra errores con stack trace y contexto completo para debugging
  error: (message, error = {}) => {
    console.error(`[ERROR] ${new Date().toISOString()} ${message}`, {
      message: error.message,
      stack: error.stack,
      ...error
    });
  },
  
  // Registra advertencias (situaciones que podrían causar problemas)
  warn: (message, meta = {}) => {
    console.warn(`[WARN] ${new Date().toISOString()} ${message}`, meta);
  },
  
  // Registra mensajes de debugging (solo en entorno de desarrollo)
  debug: (message, meta = {}) => {
    if (config.env === "development") {
      console.log(`[DEBUG] ${new Date().toISOString()} ${message}`, meta);
    }
  }
};

// Wrapper para manejo automático de errores asíncronos en Express
export const asyncHandler = (fn) => {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
};

// Crea errores estructurados con código HTTP y código de error personalizado
export const createError = (message, statusCode = 500, code = "INTERNAL_ERROR") => {
  const error = new Error(message);
  error.statusCode = statusCode;  // Código HTTP para la respuesta
  error.code = code;             // Código de error para el cliente
  return error;
};

// Escapa caracteres HTML para prevenir XSS en entradas de usuario
export const escapeHtml = (str = "") => {
  return str
    .replaceAll("&", "&amp;")   // Ampersand
    .replaceAll("<", "&lt;")    // Menor que
    .replaceAll(">", "&gt;")    // Mayor que
    .replaceAll('"', "&quot;")  // Comillas dobles
    .replaceAll("'", "&#039;"); // Apóstrofe
};

// Limpia y normaliza strings (elimina espacios en blanco)
export const sanitizeString = (str) => {
  return typeof str === "string" ? str.trim() : "";
};

// Valida formato de email usando expresión regular
export const validateEmail = (email) => {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
};

// Obtiene el primer elemento de un array si existe, null si está vacío
export const pickFirst = (arr) => {
  return Array.isArray(arr) && arr.length > 0 ? arr[0] : null;
};

// Convierte diferentes formatos de lista de usuarios a array consistente
export const parseUserList = (users) => {
  if (Array.isArray(users)) return users.filter(Boolean); // Si ya es array, solo filtra nulos
  if (typeof users === "string") {
    // Si es string separado por comas, convierte a array
    return users.split(",").map(u => sanitizeString(u)).filter(Boolean);
  }
  return []; // Si es otro tipo, devuelve array vacío
};

// Genera nombre de archivo consistente para certificados
export const generateFileName = (empresa, numCert, serial, originalName, timestamp) => {
  const extension = originalName ? originalName.substring(originalName.lastIndexOf(".")) : ".pdf";
  return `${empresa}_${numCert}_${serial}_${timestamp}${extension}`;
};

// Sistema de reintentos automáticos para operaciones externas (ej: APIs)
export const retryOperation = async (operation, maxRetries = 2, delay = 1000) => {
  let lastError;
  
  // Intenta la operación hasta maxRetries + 1 veces
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await operation(); // Ejecuta la operación asíncrona
    } catch (error) {
      lastError = error;
      
      // Detecta si es error de autenticación (401/invalid_grant)
      const isAuthError = error?.response?.status === 401 || 
                         error?.response?.data?.error === "invalid_grant" ||
                         error?.errors?.[0]?.reason === "invalid_grant";
      
      // Si no es error de auth o ya no hay más intentos, lanza el error
      if (attempt === maxRetries || !isAuthError) {
        throw error;
      }
      
      // Registra el intento de reintento
      logger.warn(`Retry attempt ${attempt + 1}/${maxRetries + 1} after auth error`, {
        error: error.message
      });
      
      // Espera antes de reintentar (delay incremental)
      await new Promise(resolve => setTimeout(resolve, delay * (attempt + 1)));
    }
  }
  
  throw lastError; // Lanza el último error si todos los intentos fallaron
};