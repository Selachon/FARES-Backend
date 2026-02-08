// Archivo de utilidades comunes del sistema
// Contiene funciones para logging, manejo de errores, sanitización, validación y utilidades varias
import { config } from "./config.js";

// Función auxiliar para obtener timestamp en formato ISO
const getTimestamp = () => new Date().toISOString();

// Sistema de logging centralizado con diferentes niveles de severidad
export const logger = {
  // Registra mensajes informativos
  info: (message, meta = {}) => {
    console.log(`[INFO] ${getTimestamp()} ${message}`, meta);
  },
  
  // Registra mensajes de error con detalles del error
  error: (message, error = {}) => {
    console.error(`[ERROR] ${getTimestamp()} ${message}`, {
      message: error.message,
      stack: error.stack,
      ...error
    });
  },
  
  // Registra mensajes de advertencia
  warn: (message, meta = {}) => {
    console.warn(`[WARN] ${getTimestamp()} ${message}`, meta);
  },
  
  // Registra mensajes de depuración (solo en desarrollo)
  debug: (message, meta = {}) => {
    if (config.env === "development") {
      console.log(`[DEBUG] ${getTimestamp()} ${message}`, meta);
    }
  }
};

// Middleware para manejo de funciones asíncronas en Express
// Captura automáticamente errores y los pasa al middleware de errores
export const asyncHandler = (fn) => {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
};

// Crea un error personalizado con código de estado HTTP y código de error
export const createError = (message, statusCode = 500, code = "INTERNAL_ERROR") => {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
};

// Escapa caracteres HTML para prevenir ataques XSS
export const escapeHtml = (str = "") => {
  const htmlEscapes = {
    '&': '&amp;',    // Ampersand
    '<': '&lt;',     // Menor que
    '>': '&gt;',     // Mayor que
    '"': '&quot;',   // Comillas dobles
    "'": '&#039;'    // Comilla simple
  };
  
  return str.replace(/[&<>"']/g, char => htmlEscapes[char]);
};

// Sanitiza una cadena de texto eliminando espacios en blanco
// Rechaza cualquier valor que no sea string primitivo (previene NoSQL injection con objetos como {$gt:""})
export const sanitizeString = (str) => {
  if (typeof str !== "string") return "";
  return str.trim();
};

// Sanitiza un valor para uso seguro en queries MongoDB
// Rechaza cualquier valor que no sea string/number primitivo (previene operadores NoSQL como {$gt:""})
export const mongoSafeValue = (val) => {
  if (val === null || val === undefined) return "";
  if (typeof val === "number" && Number.isFinite(val)) return val;
  if (typeof val === "string") return val.trim();
  // Objetos, arrays, funciones → rechazados
  return "";
};

// Valida formato de email usando expresión regular básica
export const validateEmail = (email) => {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
};

// Obtiene el primer elemento de un array si existe, null si no
export const pickFirst = (arr) => {
  return Array.isArray(arr) && arr.length > 0 ? arr[0] : null;
};

// Convierte una lista de usuarios en array, manejando diferentes formatos de entrada
export const parseUserList = (users) => {
  if (Array.isArray(users)) return users.filter(Boolean);
  if (typeof users === "string") {
    return users.split(",").map(u => sanitizeString(u)).filter(Boolean);
  }
  return [];
};

// Genera nombre de archivo para certificados con formato estándar
export const generateFileName = (empresa, numCert, serial, originalName, timestamp) => {
  const extension = originalName ? originalName.substring(originalName.lastIndexOf(".")) : ".pdf";
  return `${empresa}_${numCert}_${serial}_${timestamp}${extension}`;
};

// Función de reintento con backoff exponencial para operaciones asíncronas
// Útil para operaciones de API que pueden fallar temporalmente (especialmente OAuth)
export const retryOperation = async (operation, maxRetries = 2, baseDelay = 1000) => {
  let lastError;
  
  // Bucle de intentos desde 0 hasta maxRetries
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      // Intentar ejecutar la operación
      return await operation();
    } catch (error) {
      lastError = error;
      
      // Detectar si es un error de autenticación que puede resolverse con reintento
      const isAuthError = error?.response?.status === 401 || 
                         error?.response?.data?.error === "invalid_grant" ||
                         error?.errors?.[0]?.reason === "invalid_grant";
      
      // Si es el último intento o no es error de auth, lanzar el error
      if (attempt === maxRetries || !isAuthError) {
        throw error;
      }
      
      // Calcular delay de reintento (creciente)
      const retryDelay = baseDelay * (attempt + 1);
      logger.warn(`Retry attempt ${attempt + 1}/${maxRetries + 1} after auth error`, {
        error: error.message
      });
      
      // Esperar antes del próximo intento
      await new Promise(resolve => setTimeout(resolve, retryDelay));
    }
  }
  
  // Si todos los intentos fallaron, lanzar el último error
  throw lastError;
};