// Archivo de gestión de conexión a base de datos MongoDB
// Exporta funciones para conectar y manejar la base de datos, incluyendo seed de datos iniciales
import { MongoClient } from "mongodb";
import { config } from "./config.js";
import { logger } from "./utils.js";

// Variables globales para mantener la conexión activa (singleton pattern)
let client, db;

// Función principal para conectar a la base de datos MongoDB
// Implementa patrón singleton para reutilizar la conexión existente
export async function connect() {
  // Si ya existe una conexión, retornarla (el driver maneja reconexión automáticamente)
  if (db) {
    return db;
  }

  try {
    // Crear nuevo cliente MongoDB con configuración
    client = new MongoClient(config.mongodb.uri, config.mongodb.options);
    // Establecer conexión con el servidor
    await client.connect();
    
    // Obtener referencia a la base de datos específica
    db = client.db(config.mongodb.dbName);
    logger.info("Database connected", { database: config.mongodb.dbName });
    
    // Ensure required indexes exist
    await ensureIndexes(db);
    // Ejecutar seed de datos iniciales si está configurado
    await seed(db);
    return db;
  } catch (error) {
    // Registrar error de conexión y lanzar excepción en español
    logger.error("Database connection failed", error);
    throw new Error("No se pudo conectar a la base de datos");
  }
}

/**
 * Ensure required database indexes exist.
 * Creates indexes for performance and data integrity constraints.
 */
async function ensureIndexes(db) {
  try {
    // Drafts: unique index on localId for idempotent creates (prevents duplicates on retries)
    await db.collection("drafts").createIndex(
      { localId: 1 },
      { unique: true, sparse: true, name: "idx_localId_unique" }
    );

    // Certificates: index for user-scoped queries
    await db.collection("certificates").createIndex(
      { empresa: 1, assignedUsers: 1 },
      { name: "idx_empresa_assignedUsers" }
    );

    logger.info("Database indexes ensured");
  } catch (error) {
    // Log but don't fail startup - indexes may already exist
    logger.warn("Index creation warning (may already exist)", { message: error.message });
  }
}

// Función para poblar la base de datos con datos iniciales (seed)
// Solo se ejecuta si SEED_DEMO="1" está configurado en variables de entorno
async function seed(db) {
  // Verificar si el seed está habilitado
  if (process.env.SEED_DEMO !== "1") {
    logger.info("Seed skipped (SEED_DEMO not enabled)");
    return;
  }

  // Referencias a colecciones de usuarios y certificados
  const users = db.collection("users");
  const certs = db.collection("certificates");

  try {
    // Contar documentos existentes en ambas colecciones en paralelo
    const [userCount, certCount] = await Promise.all([
      users.countDocuments(),
      certs.countDocuments()
    ]);

    // Si no hay usuarios, crear usuarios de demostración
    if (userCount === 0) {
      // Importar bcryptjs dinámicamente para el hashing de contraseñas
      const bcrypt = await import("bcryptjs");

      // Generar hashes de contraseñas para usuarios admin y cliente
      const [adminHash, clienteHash] = await Promise.all([
        bcrypt.default.hash("admin123", 10),    // Hash para admin
        bcrypt.default.hash("cliente123", 10), // Hash para cliente
      ]);

      // Insertar usuarios de demostración
      await users.insertMany([
        {
          username: "admin",
          password: adminHash,
          role: "ADMIN",
          empresa: "FARES",
          createdAt: new Date(),
        },
        {
          username: "cliente1",
          password: clienteHash,
          role: "USER",
          empresa: "EMPRESA_DEMO",
          createdAt: new Date(),
        },
      ]);

      logger.info("Seed users created", {
        users: ["admin", "cliente1"],
        database: db.databaseName,
      });
    }

    // Si no hay certificados, crear certificados de demostración
    if (certCount === 0) {
      const now = new Date();
      const demoCerts = [
        {
          numCert: 1001,
          serial: "T-ABC-001",
          fechaCargue: new Date("2024-01-15"),
          resultado: "CUMPLE",
          empresa: "EMPRESA_DEMO",
          assignedUsers: ["cliente1"],
          links: {
            informes: "https://drive.google.com/file/d/DEMO_INF/view",
            formatos: "https://drive.google.com/file/d/DEMO_FOR/view",
            certificados: "https://drive.google.com/file/d/DEMO_CERT/view",
          },
          createdAt: now,
        },
        {
          numCert: 1002,
          serial: "T-XYZ-002",
          fechaCargue: new Date("2024-02-20"),
          resultado: "NO CUMPLE",
          empresa: "EMPRESA_DEMO",
          assignedUsers: ["cliente1"],
          links: {
            informes: "https://drive.google.com/file/d/DEMO_INF2/view",
            formatos: "https://drive.google.com/file/d/DEMO_FOR2/view",
            certificados: "https://drive.google.com/file/d/DEMO_CERT2/view",
          },
          createdAt: now,
        },
      ];

      await certs.insertMany(demoCerts);
      logger.info("Demo certificates created", { count: demoCerts.length });
    }
  } catch (error) {
    // Registrar error del seed pero no detener la aplicación
    logger.error("Seed operation failed", error);
  }
}

