// Cargar variables de entorno desde archivo .env
import dotenv from "dotenv";

dotenv.config();

// Configuración centralizada de toda la aplicación
export const config = {
  // Configuración del entorno de ejecución
  env: process.env.NODE_ENV || "development",
  isLocal:
    process.env.LOCAL_DEV === "1" || process.env.NODE_ENV !== "production", // Determina si estamos en entorno local
  isRender: String(process.env.RENDER || "").toLowerCase() === "true", // Detecta si corre en Render.com

  // Configuración del servidor HTTP
  server: {
    port: parseInt(process.env.PORT) || 3000, // Puerto del servidor
    host: process.env.HOST || "0.0.0.0", // Host del servidor
  },

  // Configuración de CORS para permitir solicitudes desde otros dominios
  cors: {
    allowedOrigins: [
      "https://faresbcs.com", // Dominio principal en producción
      "https://www.faresbcs.com", // Subdominio www
      "http://localhost:5173", // Frontend en desarrollo
      ...(process.env.LOCAL_DEV === "1" ? ["http://127.0.0.1:5173"] : []), // localhost alternativo
    ],
  },

  // Configuración de conexión a MongoDB
  mongodb: {
    uri: process.env.MONGODB_URI, // URL de conexión a MongoDB
    dbName:
      process.env.LOCAL_DEV === "1" && process.env.MONGODB_LOCAL_DB
        ? process.env.MONGODB_LOCAL_DB // Base de datos local si está configurada
        : "fares", // Base de datos por defecto en producción
    options: {
      serverSelectionTimeoutMS: 8000, // Timeout para seleccionar servidor (8 segundos)
      maxPoolSize: 10, // Máximo de conexiones en el pool
      minPoolSize: 2, // Mínimo de conexiones mantenidas
      maxIdleTimeMS: 30000, // Tiempo máximo que una conexión puede estar inactiva (30 seg)
      waitQueueTimeoutMS: 5000, // Tiempo máximo en cola de espera (5 seg)
    },
  },

  // Configuración del servicio de correo electrónico (Brevo API v3)
  email: {
    host: process.env.EMAIL_HOST,                    // Servidor SMTP (legacy)

    // Puerto SMTP (587 por defecto para Brevo / STARTTLS)
    port: Number(process.env.EMAIL_PORT) || 587,

    // secure SOLO true si el puerto es 465 (SMTPS)
    // Para puerto 587 con STARTTLS, secure debe ser false
    secure:
      process.env.EMAIL_SECURE !== undefined
        ? process.env.EMAIL_SECURE === "true"
        : Number(process.env.EMAIL_PORT) === 465,

    user: process.env.EMAIL_USER,                    // Usuario SMTP (legacy)
    pass: process.env.EMAIL_PASS,                    // Contraseña SMTP (legacy)

    // Remitente y destinatario del correo
    from: process.env.EMAIL_FROM || process.env.EMAIL_USER, // Email del remitente
    to: process.env.EMAIL_TO || process.env.EMAIL_USER,     // Email del destinatario
    
    // API Key de Brevo (recomendado sobre SMTP)
    // Se usa para comunicación directa con API REST v3
    brevoApiKey: process.env.BREVO_API_KEY,             // Clave API de Brevo
  },

  // Configuración de APIs de Google
  google: {
    // Configuración de OAuth2 para autenticación
    oauth: {
      clientId: process.env.GOOGLE_OAUTH_CLIENT_ID, // ID de cliente OAuth2
      clientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET, // Secreto de cliente OAuth2
      refreshToken: process.env.GOOGLE_OAUTH_REFRESH_TOKEN, // Token de actualización OAuth2
    },
    // Configuración específica de Google Drive
    drive: {
      parentFolderId: process.env.DRIVE_PARENT_FOLDER_ID, // ID de carpeta principal
      folders: {
        INF: process.env.DRIVE_FOLDER_INF, // Carpeta para informes
        FOR: process.env.DRIVE_FOLDER_FOR, // Carpeta para formatos
        CERT: process.env.DRIVE_FOLDER_CERT, // Carpeta para certificados
      },
      share: {
        type: process.env.DRIVE_SHARE_TYPE || "anyone", // Tipo de compartición
        role: process.env.DRIVE_SHARE_ROLE || "reader", // Rol de compartición
        domain: process.env.DRIVE_DOMAIN, // Dominio (si aplica)
      },
    },
  },

  // Configuración de subida de archivos
  upload: {
    dest: "uploads/", // Directorio temporal de subidas
    maxFileSize: 10 * 1024 * 1024, // Tamaño máximo de archivo: 10MB
    allowedMimeTypes: [
      // Tipos MIME permitidos
      "application/pdf", // PDF
      "image/jpeg", // Imágenes JPG
      "image/png", // Imágenes PNG
      "application/msword", // Word (.doc)
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document", // Word (.docx)
    ],
  },
};

export const validateConfig = () => {
  const requiredVars = [
    "MONGODB_URI",
    "GOOGLE_OAUTH_CLIENT_ID",
    "GOOGLE_OAUTH_CLIENT_SECRET",
    "GOOGLE_OAUTH_REFRESH_TOKEN",
  ];

  const missing = requiredVars.filter((varName) => !process.env[varName]);

  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missing.join(", ")}`,
    );
  }

  return true;
};
