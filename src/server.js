// Importaciones principales del framework y módulos locales
import express from "express";
import cors from "cors";
import morgan from "morgan";
import { config } from "./config.js";
import { logger } from "./utils.js";
import { 
  corsMiddleware, 
  requestLogger, 
  errorHandler, 
  notFoundHandler,
  healthMiddleware 
} from "./middleware.js";
import apiRoutes from "./routes/api.js";
import { emailService } from "./emailService.js";

// Creación de la aplicación Express
const app = express();

// Configuración de CORS para permitir solicitudes desde dominios específicos
app.use(cors({
  origin: config.cors.allowedOrigins, // Dominios permitidos
  credentials: true                   // Permite cookies y autenticación
}));
app.options("*", cors()); // Habilita pre-flight requests

// Middleware personalizados
app.use(corsMiddleware);                    // Control adicional de CORS
app.use(express.json({ limit: "10mb" }));   // Parseo de JSON (10MB max)
app.use(express.urlencoded({ extended: true, limit: "10mb" })); // Parseo de formularios
app.use(morgan(config.env === "production" ? "combined" : "dev")); // Logs HTTP
app.use(requestLogger);                        // Logger personalizado con métricas

// Endpoints básicos del sistema
app.get("/", (_, res) => res.status(200).send("OK")); // Health check simple
app.get("/healthz", healthMiddleware);              // Health check detallado

// Monta rutas de la API bajo prefijo /api
app.use("/api", apiRoutes);

// Middleware para manejo de errores (deben ir al final)
app.use(notFoundHandler); // Para rutas no encontradas (404)
app.use(errorHandler);    // Para errores generales (500)

// Endpoint TEMPORAL para verificar SMTP
app.get("/email/verify", async (req, res) => {
  try {
    if (!emailService.isConfigured()) {
      return res.status(500).json({
        ok: false,
        error: "Email service not configured",
      });
    }

    const result = await emailService.verify();

    return res.json({
      ok: result.ok,
      verifiedAt: new Date().toISOString(),
      details: result.error || null,
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: err.message || "Unknown error",
    });
  }
});

// Manejo de rechazos de promesas no manejados
process.on("unhandledRejection", (reason, promise) => {
  logger.error("Unhandled Rejection", { reason, promise });
});

// Manejo de excepciones no capturadas (error crítico)
process.on("uncaughtException", (error) => {
  logger.error("Uncaught Exception", error);
  process.exit(1); // Termina proceso inmediatamente
});

// Función para apagado graceful del servidor
const gracefulShutdown = (signal) => {
  logger.info(`Received ${signal}, shutting down gracefully`);
  
  // Cierra servidor HTTP para no aceptar más conexiones
  server.close(() => {
    logger.info("HTTP server closed");
    
    // Cierra conexión a base de datos antes de terminar
    import("./db.js").then(({ client }) => {
      if (client) {
        client.close(() => {
          logger.info("MongoDB connection closed");
          process.exit(0);
        });
      } else {
        process.exit(0);
      }
    });
  });
  
  // Forza apagado después de 10 segundos si no se completa gracefully
  setTimeout(() => {
    logger.error("Forced shutdown after timeout");
    process.exit(1);
  }, 10000);
};

// Inicia servidor en puerto y host configurados
const server = app.listen(config.server.port, config.server.host, () => {
  logger.info(`Server started`, {
    env: config.env,
    host: config.server.host,
    port: config.server.port,
    local: config.isLocal
  });
});

// Registra manejadores para señales del sistema operativo
process.on("SIGTERM", () => gracefulShutdown("SIGTERM")); // Señal de terminación (ej: k8s)
process.on("SIGINT", () => gracefulShutdown("SIGINT"));   // Señal de interrupción (Ctrl+C)

export default app;