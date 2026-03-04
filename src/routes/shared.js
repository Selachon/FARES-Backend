/**
 * Shared utilities and middleware for route modules.
 */
import multer from "multer";
import rateLimit from "express-rate-limit";
import crypto from "crypto";
import { config } from "../config.js";
import { connect } from "../db.js";

// Shared upload middleware with MIME validation.
export const upload = multer({
  dest: config.upload.dest,
  limits: { fileSize: config.upload.maxFileSize },
  fileFilter: (_req, file, cb) => {
    if (config.upload.allowedMimeTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`Tipo de archivo no permitido: ${file.mimetype}`), false);
    }
  },
});

// Login brute-force protection: 5 attempts per 15 minutes.
export const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: {
    message: "Demasiados intentos de inicio de sesión. Intenta nuevamente en 15 minutos.",
    code: "TOO_MANY_REQUESTS"
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// Contact form throttling: 3 requests per hour.
export const contactLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 3,
  message: {
    message: "Demasiados mensajes de contacto. Intenta nuevamente en 1 hora.",
    code: "TOO_MANY_REQUESTS"
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// App auth rate limiting: 20 attempts per minute.
export const appAuthLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  message: {
    message: "Demasiados intentos de autenticación de app. Intenta en 1 minuto.",
    code: "TOO_MANY_REQUESTS",
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// App routes rate limiting: 120 requests per minute.
export const appRoutesLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  message: {
    message: "Demasiadas solicitudes de app. Intenta más tarde.",
    code: "TOO_MANY_REQUESTS",
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// Hash a secret using SHA-256.
export const hashSecret = (secret) =>
  crypto.createHash("sha256").update(String(secret || "")).digest("hex");

// Timing-safe comparison of secrets (prevents timing attacks).
export const safeEqualSecret = (plainTextSecret, storedHash) => {
  const incoming = hashSecret(plainTextSecret);
  const a = Buffer.from(incoming, "utf8");
  const b = Buffer.from(String(storedHash || ""), "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
};

// Get app_devices collection with index.
export const appDevicesCollection = async () => {
  const db = await connect();
  const col = db.collection("app_devices");
  await col.createIndex({ deviceId: 1 }, { unique: true });
  return col;
};

// Get enrollment_tokens collection with indexes.
export const enrollmentTokensCollection = async () => {
  const db = await connect();
  const col = db.collection("enrollment_tokens");
  await col.createIndex({ tokenId: 1 }, { unique: true });
  await col.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
  return col;
};
