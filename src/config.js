// Archivo de configuración principal del sistema
// Carga variables de entorno y define configuraciones para servidor, base de datos, email, Google Drive, etc.
import dotenv from "dotenv";

// Cargar variables de entorno desde archivo .env
dotenv.config();

const parseCsv = (value) =>
  String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

// Determinar si estamos en entorno de desarrollo local
const LOCAL_DEV = process.env.LOCAL_DEV === "1";
// Entorno de ejecución (development, production, etc.)
const NODE_ENV = process.env.NODE_ENV || "development";
const IS_RAILWAY = Boolean(process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_SERVICE_ID);
const IS_RENDER = String(process.env.RENDER || "").toLowerCase() === "true";
const MONGODB_URI = IS_RAILWAY
  ? (process.env.MONGO_URL || process.env.MONGODB_URI || process.env.DATABASE_URL)
  : (process.env.MONGODB_URI || process.env.MONGO_URL || process.env.DATABASE_URL);

const inferMongoTls = (uri) => {
  if (process.env.MONGODB_TLS !== undefined) {
    return process.env.MONGODB_TLS !== "0";
  }

  const normalized = String(uri || "").toLowerCase();
  return normalized.startsWith("mongodb+srv://") || normalized.includes("tls=true") || normalized.includes("ssl=true");
};

// Objeto de configuración centralizado
export const config = {
  // Entorno de ejecución actual
  env: NODE_ENV,
  // Indica si es entorno local o no producción
  isLocal: LOCAL_DEV || NODE_ENV !== "production",
  // Verifica si se está ejecutando en Railway
  isRailway: IS_RAILWAY,
  // Verifica si se está ejecutando en Render.com
  isRender: IS_RENDER,

  // Configuración del servidor HTTP
  server: {
    // Puerto de escucha del servidor
    port: parseInt(process.env.PORT) || 3000,
    // Host donde escucha el servidor
    host: process.env.HOST || "0.0.0.0",
  },

  // Configuración de CORS para permitir peticiones cross-origin
  cors: {
    // Orígenes permitidos para peticiones al API
    allowedOrigins: [
      "https://faresbcs.com",
      "https://www.faresbcs.com",
      "http://localhost:5173",
      // Agregar localhost con IP en desarrollo local
      ...(LOCAL_DEV ? ["http://127.0.0.1:5173"] : []),
      ...parseCsv(process.env.CORS_ALLOWED_ORIGINS),
    ],
    allowRailwayOrigins: process.env.ALLOW_RAILWAY_ORIGINS === "1" || IS_RAILWAY,
    allowRenderOrigins: process.env.ALLOW_RENDER_ORIGINS === "1" || IS_RENDER,
  },

  // Configuración de la conexión a MongoDB
  mongodb: {
    // URI de conexión a la base de datos
    uri: MONGODB_URI,
    // Nombre de la base de datos (usa local si está definida, sino "fares")
    dbName: LOCAL_DEV && process.env.MONGODB_LOCAL_DB
        ? process.env.MONGODB_LOCAL_DB
        : "fares",
    // Opciones de conexión a MongoDB
    options: {
      // Tiempo máximo para selección de servidor (8 segundos)
      serverSelectionTimeoutMS: 8000,
      // Tamaño máximo del pool de conexiones
      maxPoolSize: 10,
      // Tamaño mínimo del pool de conexiones
      minPoolSize: 2,
      // Tiempo máximo de inactividad de conexión (30 segundos)
      maxIdleTimeMS: 30000,
      // Tiempo máximo en cola de espera (5 segundos)
      waitQueueTimeoutMS: 5000,
      // Habilitar TLS/SSL
      tls: inferMongoTls(MONGODB_URI),
      // Solo permitir certificados TLS inválidos cuando se habilite explícitamente.
      // Atlas no necesita esto y puede rechazar la negociación TLS si está activo.
      ...(process.env.MONGODB_TLS_ALLOW_INVALID === "1" && {
        tlsAllowInvalidCertificates: true,
        tlsAllowInvalidHostnames: true,
      }),
    },
  },

  // Configuración del servicio de email (Brevo/SendInBlue)
  email: {
    // Servidor SMTP host
    host: process.env.EMAIL_HOST,
    // Puerto del servidor SMTP (por defecto 587)
    port: Number(process.env.EMAIL_PORT) || 587,
    // Conexión segura (SSL/TLS) - true si puerto 465
    secure: process.env.EMAIL_SECURE !== undefined
        ? process.env.EMAIL_SECURE === "true"
        : Number(process.env.EMAIL_PORT) === 465,
    // Usuario del servidor SMTP
    user: process.env.EMAIL_USER,
    // Contraseña del servidor SMTP
    pass: process.env.EMAIL_PASS,
    // Email remitente (por defecto usa el usuario)
    from: process.env.EMAIL_FROM || process.env.EMAIL_USER,
    // Email destinatario (por defecto usa el usuario)
    to: process.env.EMAIL_TO || process.env.EMAIL_USER,
    // API key de Brevo para envío de correos
    brevoApiKey: process.env.BREVO_API_KEY,
  },

  // Configuración de Google OAuth y Drive
  google: {
    // Credenciales de OAuth 2.0 de Google
    oauth: {
      // ID de cliente de la aplicación OAuth
      clientId: process.env.GOOGLE_OAUTH_CLIENT_ID,
      // Secreto de cliente de la aplicación OAuth
      clientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET,
      // Token de refresco para renovar accesos automáticamente
      refreshToken: process.env.GOOGLE_OAUTH_REFRESH_TOKEN,
    },
    // Configuración de Google Drive
    drive: {
      // ID de la carpeta principal en Google Drive
      parentFolderId: process.env.DRIVE_PARENT_FOLDER_ID,
      // IDs de carpetas específicas para cada tipo de documento
      folders: {
        // Carpeta para informes
        INF: process.env.DRIVE_FOLDER_INF,
        // Carpeta para formatos
        FOR: process.env.DRIVE_FOLDER_FOR,
        // Carpeta para certificados
        CERT: process.env.DRIVE_FOLDER_CERT,
      },
      // Configuración de permisos de compartición
      share: {
        // Tipo de acceso (anyone, user, domain)
        type: process.env.DRIVE_SHARE_TYPE || "anyone",
        // Rol de acceso (reader, writer, commenter)
        role: process.env.DRIVE_SHARE_ROLE || "reader",
        // Dominio para acceso restringido (si type es domain)
        domain: process.env.DRIVE_DOMAIN,
      },
    },
  },

  // Configuración para carga de archivos
  upload: {
    // Directorio temporal para archivos subidos
    dest: "uploads/",
    // Tamaño máximo de archivo (10 MB)
    maxFileSize: 10 * 1024 * 1024,
    // Tipos MIME permitidos para archivos
    allowedMimeTypes: [
      "application/pdf",                                            // Archivos PDF
      "image/jpeg",                                                // Imágenes JPEG
      "image/png",                                                 // Imágenes PNG
      "application/msword",                                        // Documentos Word (.doc)
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document", // Documentos Word (.docx)
    ],
  },

  // Configuración de autenticación JWT
  jwt: {
    // Secreto para firmar tokens JWT (DEBE estar en .env)
    secret: process.env.JWT_SECRET,
    // Tiempo de expiración del token (24 horas)
    expiresIn: "24h",
    // Configuración de cookie
    cookie: {
      name: "fares_session",
      httpOnly: true,
      secure: !LOCAL_DEV && NODE_ENV === "production",
      sameSite: LOCAL_DEV ? "lax" : "none",
      maxAge: 24 * 60 * 60 * 1000, // 24 horas en milisegundos
    },
  },

  // Configuración de seguridad
  security: {
    // Clave API legacy para app móvil (transición, opcional)
    appApiKey: process.env.APP_API_KEY,
    // Secreto para firmar tokens de acceso de app móvil
    appJwtSecret: process.env.APP_JWT_SECRET || process.env.JWT_SECRET,
    // Vida corta para minimizar impacto de token filtrado
    appJwtExpiresIn: process.env.APP_JWT_EXPIRES_IN || "15m",
    // Compatibilidad temporal para clientes legados con solo x-app-key
    allowLegacyAppKey: process.env.ALLOW_LEGACY_APP_KEY === "1",
    // Secreto para firmar enrollment tokens (provisión de dispositivos)
    enrollmentSecret: process.env.ENROLLMENT_SECRET || process.env.JWT_SECRET,
    // Tiempo de vida de enrollment tokens (default 7 días)
    enrollmentTokenExpiresIn: process.env.ENROLLMENT_TOKEN_EXPIRES_IN || "7d",
    // Requerir enrollment token para registro de dispositivos (default true en prod)
    requireEnrollmentToken: process.env.REQUIRE_ENROLLMENT_TOKEN !== "0",
    // Máximo de dispositivos por enrollment token
    maxDevicesPerEnrollment: parseInt(process.env.MAX_DEVICES_PER_ENROLLMENT) || 5,
  },
};

// Lista de variables de entorno obligatorias para el funcionamiento del sistema
const REQUIRED_VARS = [
  "GOOGLE_OAUTH_CLIENT_ID",         // ID de cliente OAuth de Google
  "GOOGLE_OAUTH_CLIENT_SECRET",     // Secreto de cliente OAuth de Google
  "GOOGLE_OAUTH_REFRESH_TOKEN",     // Token de refresco OAuth de Google
  "JWT_SECRET",                     // Secreto para firmar tokens JWT
];

// Función para validar que todas las variables de entorno requeridas estén presentes
export const validateConfig = () => {
  // Filtrar las variables que faltan
  const missing = REQUIRED_VARS.filter(varName => !process.env[varName]);

  if (!config.mongodb.uri) {
    missing.unshift("MONGODB_URI or MONGO_URL or DATABASE_URL");
  }

  // Si faltan variables, lanzar error
  if (missing.length) {
    throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
  }

  // Si todo está correcto, retornar verdadero
  return true;
};
