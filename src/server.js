// Archivo principal del servidor web
// Configura y arranca el servidor Express con todos los middlewares y rutas
import express from "express";
import cors from "cors";
import morgan from "morgan";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import rateLimit from "express-rate-limit";
import { config } from "./config.js";
import { logger } from "./utils.js";
import { 
  corsMiddleware, 
  isAllowedOrigin,
  requestLogger, 
  errorHandler, 
  notFoundHandler,
  healthMiddleware,
  csrfProtection
} from "./middleware.js";
import apiRoutes from "./routes/api.js";

// Crear instancia de aplicación Express
const app = express();

// Confiar en el proxy reverso (Render, Nginx, etc.) para obtener la IP real
// del cliente a partir del header X-Forwarded-For. Sin esto, express-rate-limit
// identifica a todos los usuarios con la IP del proxy.
if (config.isRender || config.env === "production") {
  app.set("trust proxy", 1);
}

// Aplicar helmet para headers de seguridad
app.use(helmet({
  contentSecurityPolicy: config.env === "production" ? undefined : false,
  crossOriginEmbedderPolicy: false,
}));

// Configurar middleware CORS global con política consistente
const corsOptions = {
  origin: (origin, callback) => {
    callback(null, isAllowedOrigin(origin));
  },
  credentials: true,                   // Permitir cookies y autenticación
  exposedHeaders: ["Content-Disposition"],
};
app.use(cors(corsOptions));
// Habilitar preflight OPTIONS con las mismas restricciones de origen
app.options("*", cors(corsOptions));

// Aplicar middleware personalizado de CORS (validación adicional)
app.use(corsMiddleware);
// Middleware para parsear cookies
app.use(cookieParser());
// Middleware para parsear JSON con límite de 10MB
app.use(express.json({ limit: "10mb" }));
// Middleware para parsear form data URL-encoded con límite de 10MB
app.use(express.urlencoded({ extended: true, limit: "10mb" }));
// Middleware de logging HTTP (formato diferente para producción/development)
app.use(morgan(config.env === "production" ? "combined" : "dev"));
// Middleware personalizado de logging de peticiones
app.use(requestLogger);

// CSRF protection for state-changing requests (POST, PUT, PATCH, DELETE)
// Validates Origin/Referer against allowed origins
app.use(csrfProtection);

// Rate limiter global: 200 peticiones por IP por minuto (protege contra DDoS/scraping)
app.use(rateLimit({
  windowMs: 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Demasiadas solicitudes, intenta más tarde", code: "TOO_MANY_REQUESTS" },
}));

// Rutas básicas
app.get("/", (_, res) => res.status(200).send("OK"));  // Endpoint de verificación simple
app.get("/healthz", healthMiddleware);                 // Endpoint de health check para orchestration

// Montar rutas de API bajo /api
app.use("/api", apiRoutes);

// Middleware para manejar rutas no encontradas (404)
app.use(notFoundHandler);
// Middleware para manejar errores globalmente
app.use(errorHandler);

// Manejar promesas rechazadas no capturadas
process.on("unhandledRejection", (reason, promise) => {
  logger.error("Unhandled Rejection", { reason, promise });
});

// Manejar excepciones no capturadas
process.on("uncaughtException", (error) => {
  logger.error("Uncaught Exception", error);
  process.exit(1);  // Salir inmediatamente en caso de excepción no capturada
});

// Función para apagado graceful del servidor
// Cierra conexiones de forma ordenada al recibir señales del sistema
const gracefulShutdown = (signal) => {
  logger.info(`Received ${signal}, shutting down gracefully`);
  
  server.close(async () => {
    logger.info("HTTP server closed");
    
    try {
      // Cerrar conexión a MongoDB si está activa
      const { client } = await import("./db.js");
      if (client) {
        await client.close();
        logger.info("MongoDB connection closed");
      }
      process.exit(0);
    } catch (error) {
      logger.error("Error during shutdown", error);
      process.exit(1);
    }
  });
  
  // Forzar cierre si el graceful shutdown tarda demasiado (10 segundos)
  setTimeout(() => {
    logger.error("Forced shutdown after timeout");
    process.exit(1);
  }, 10000);
};

// Iniciar servidor HTTP en puerto y host configurados
const server = app.listen(config.server.port, config.server.host, () => {
  logger.info(`Server started`, {
    env: config.env,
    host: config.server.host,
    port: config.server.port,
    local: config.isLocal
  });
});

// Registrar manejadores para señales de apagado del sistema
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));  // Señal de terminación
process.on("SIGINT", () => gracefulShutdown("SIGINT"));    // Señal de interrupción (Ctrl+C)

export default app;
