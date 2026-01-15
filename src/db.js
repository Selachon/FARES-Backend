import { MongoClient } from "mongodb";
import dotenv from "dotenv";
dotenv.config();

let client, db;

export async function connect() {
  if (db) return db;

  const uri = process.env.MONGODB_URI;
  client = new MongoClient(uri, { serverSelectionTimeoutMS: 8000 });
  await client.connect();
  const IS_LOCAL =
    process.env.LOCAL_DEV === "1" ||
    process.env.NODE_ENV !== "production" ||
    String(process.env.RENDER || "").toLowerCase() !== "true";

  const dbName =
    IS_LOCAL && process.env.MONGODB_LOCAL_DB
      ? process.env.MONGODB_LOCAL_DB
      : "fares";

  db = client.db(dbName);
  console.log(`[MongoDB] Conectado a base de datos: "${dbName}"`);
  await seed(db);
  return db;
}

async function seed(db) {
  const users = db.collection("users");
  const certs = db.collection("certificates");

  // Seed usuarios (siempre)
  if ((await users.countDocuments()) === 0) {
    const bcrypt = await import("bcryptjs");
    const adminHash = await bcrypt.default.hash("admin123", 10);
    const clienteHash = await bcrypt.default.hash("cliente123", 10);

    await users.insertMany([
      {
        username: "admin",
        password: adminHash,
        role: "ADMIN",
        empresa: "FARES",
      },
      {
        username: "cliente1",
        password: clienteHash,
        role: "CLIENTE",
        empresa: "EMPRESA_DEMO",
      },
    ]);
    console.log("[Seed] Usuarios creados: admin (admin123), cliente1 (cliente123)");
  }

  // Seed certificados (solo en local si está vacío)
  const IS_LOCAL =
    process.env.LOCAL_DEV === "1" ||
    process.env.NODE_ENV !== "production" ||
    String(process.env.RENDER || "").toLowerCase() !== "true";

  if (IS_LOCAL && (await certs.countDocuments()) === 0) {
    await certs.insertMany([
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
      },
    ]);
    console.log("[Seed] Certificados de prueba creados (2)");
  }
}
