import { MongoClient } from "mongodb";
import { config } from "./config.js";
import { logger } from "./utils.js";

let client, db;

// Función principal de conexión a la base de datos con reconexión automática
export async function connect() {
  // Si ya existe conexión, verifica que siga activa
  if (db) {
    try {
      await db.admin().ping(); // Ping para verificar conexión
      return db;
    } catch (error) {
      logger.warn("Database connection lost, reconnecting", { error: error.message });
      db = null; // Marca como desconectado para reconectar
    }
  }

  try {
    // Crea nuevo cliente MongoDB con configuración de pool
    client = new MongoClient(config.mongodb.uri, config.mongodb.options);
    await client.connect();
    
    // Selecciona la base de datos según configuración
    db = client.db(config.mongodb.dbName);
    logger.info("Database connected", { database: config.mongodb.dbName });
    
    // Ejecuta datos iniciales (seed) si es necesario
    await seed(db);
    return db;
  } catch (error) {
    logger.error("Database connection failed", error);
    throw new Error("No se pudo conectar a la base de datos");
  }
}

// Función para inicializar datos básicos en la base de datos
async function seed(db) {
  // ⚠️ Seed solo permitido si la variable está explícitamente activada
  const shouldSeedDemo = process.env.SEED_DEMO === "1";

  if (!shouldSeedDemo) {
    logger.info("Seed skipped (SEED_DEMO not enabled)");
    return;
  }

  const users = db.collection("users");          // Colección de usuarios
  const certs = db.collection("certificates");   // Colección de certificados

  try {
    // ======================
    // Seed de usuarios demo
    // ======================
    const userCount = await users.countDocuments();
    if (userCount === 0) {
      const bcrypt = await import("bcryptjs");

      const [adminHash, clienteHash] = await Promise.all([
        bcrypt.default.hash("admin123", 10),
        bcrypt.default.hash("cliente123", 10),
      ]);

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
          role: "CLIENTE",
          empresa: "EMPRESA_DEMO",
          createdAt: new Date(),
        },
      ]);

      logger.info("Seed users created", {
        users: ["admin", "cliente1"],
        database: db.databaseName,
      });
    }

    // ===========================
    // Seed de certificados demo
    // ===========================
    const certCount = await certs.countDocuments();
    if (certCount === 0) {
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
          createdAt: new Date(),
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
          createdAt: new Date(),
        },
      ];

      await certs.insertMany(demoCerts);
      logger.info("Demo certificates created", { count: demoCerts.length });
    }
  } catch (error) {
    logger.error("Seed operation failed", error);
  }
}

