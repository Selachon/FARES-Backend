import "dotenv/config";
import { MongoClient } from "mongodb";
import { TankService } from "../src/tankService.js";
import { cleanItem } from "../src/inventoryModel.js";

// Explicit, repeatable seed of three fictional tanks for the fares demo account.
// No historical import or certificate reassignment. Supports standalone MongoDB
// for this seed only; ordinary inventory writes still require transactions.
const apply = process.argv.includes("--apply");
const uri = process.env.MONGODB_URI || process.env.MONGO_URL;
if (!uri) throw new Error("Configura MONGODB_URI");
const client = new MongoClient(uri);
try {
  await client.connect();
  const db = client.db(process.env.INVENTORY_DEMO_DB || "fares");
  const user = await db.collection("users").findOne({ username: "fares", role: "USER" });
  if (!user?.empresa) throw new Error("No existe la cuenta fares con rol USER y empresa");
  const service = new TankService({ getDb: async () => db, getClient: () => client });
  const actor = { role: "ADMIN", username: "inventory-demo-seed" };
  const examples = [
    ["001", "Bogotá", "Cundinamarca", 4.711, -74.0721, "500", "EN_INVENTARIO"],
    ["002", "Medellín", "Antioquia", 6.2442, -75.5812, "250", "POR_CONFIRMAR"],
    ["003", "Neiva", "Huila", 2.9273, -75.2819, "120", "BAJA"],
  ];
  if (apply) await service.db();
  for (const [suffix, municipio, departamento, latitud, longitud, capacidad, estado] of examples) {
    const serial = `DEMO-FARES-${suffix}`;
    const requestId = `fares-inventory-demo-v1-${suffix}`;
    const existing = await db.collection("inventory_tanks").findOne({
      $or: [{ requestId }, { empresa: user.empresa, serialNormalized: serial }],
    });
    if (existing) {
      if (existing.requestId !== requestId || existing.empresa !== user.empresa ||
          existing.assignedUsers?.length !== 1 || existing.assignedUsers[0] !== "fares")
        throw new Error(`Colisión con un registro ajeno a esta demo: ${serial}`);
      console.log(`${serial}: ya existe, se conserva`);
      continue;
    }
    if (!apply) { console.log(`${serial}: crear para fares / ${user.empresa} / ${municipio} / ${estado}`); continue; }
    const informacionItem = cleanItem({
      numeroSerie: serial, capacidad, unidadCapacidad: "GAL",
      fabricante: "Fabricante DEMO", anioFabricacion: "2024", codigoFabricacion: "DEMO",
      tipoInstalacion: "ESTACIONARIO", clasificacion: "TIPO 2", claseUso: "COMERCIAL", ubicacion: "URBANO",
      espesorCuerpo: "6", unidadEspesorCuerpo: "MM", espesorCabeza: "6", unidadEspesorCabeza: "MM",
      presionOperacion: "100", unidadPresionOperacion: "PSI", presionDisenio: "250", unidadPresionDisenio: "PSI",
      nombreUbicacion: `Sitio DEMO ${municipio}`, direccion: "Ubicación ilustrativa — datos ficticios",
      municipio, departamento, latitud, longitud,
    });
    const tank = await service.insert(db, undefined, {
      serialFabricante: serial, empresa: user.empresa, assignedUsers: ["fares"],
      tipoEquipo: "TE", informacionItem, estado,
      estadoOperativo: estado === "EN_INVENTARIO" ? "EN_SERVICIO" : "SIN_CONFIRMAR",
      observaciones: "DATOS FICTICIOS. Tanque exclusivo para demostración comercial.",
    }, actor, {
      requestId, origin: "demo", manualFields: Object.keys(informacionItem),
      lastConfirmedAt: estado === "EN_INVENTARIO" ? new Date() : null,
      ...(estado === "BAJA" ? { baja: { date: new Date().toISOString().slice(0,10), reason: "Baja ficticia para demostración", actor: actor.username } } : {}),
    });
    console.log(`${serial}: creado como ${tank.serialInterno}, sólo fares`);
  }
} finally {
  await client.close();
}
