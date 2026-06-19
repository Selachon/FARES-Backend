import ExcelJS from "exceljs";
import dotenv from "dotenv";
import { MongoClient } from "mongodb";
import fs from "fs";
import path from "path";

dotenv.config();

const monthMap = {
  enero: 0, febrero: 1, marzo: 2, abril: 3, mayo: 4, junio: 5,
  julio: 6, agosto: 7, septiembre: 8, setiembre: 8, octubre: 9,
  noviembre: 10, diciembre: 11,
};

function toCellString(value) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") {
    if (typeof value.text === "string") return value.text;
    if (Array.isArray(value.richText)) return value.richText.map((p) => p?.text || "").join("");
    if (value.result != null) return toCellString(value.result);
    if (value.hyperlink && value.text) return String(value.text);
  }
  return String(value);
}

function norm(value) {
  return String(value ?? "").trim();
}

function upper(value) {
  return norm(toCellString(value)).toUpperCase();
}

function parseSpanishDate(value) {
  if (!value && value !== 0) return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  if (typeof value === "number") {
    const ms = Math.round(value * 86400000);
    const d = new Date(Date.UTC(1899, 11, 30) + ms);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const raw = norm(toCellString(value));
  if (!raw) return null;
  const direct = new Date(raw);
  if (!Number.isNaN(direct.getTime())) return direct;
  const normalized = raw.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  const match = normalized.match(/^(\d{1,2})\s+de\s+([a-z]+)\s+de\s+(\d{4})$/);
  if (!match) return null;
  const month = monthMap[match[2]];
  if (month === undefined) return null;
  return new Date(Date.UTC(Number(match[3]), month, Number(match[1]), 12, 0, 0));
}

function mapTipoEquipo(raw) {
  const v = upper(raw);
  if (v.includes("CISTERNA")) return "CT";
  if (v.includes("ESTACIONARIO") || v.includes("ESATCIONARIO")) return "TE";
  return null;
}

function computeStatus({ fechaCargue, tipoInspeccion, tipoEquipo }) {
  let years = null;
  if (tipoInspeccion === "PARCIAL") years = 1;
  else if (tipoInspeccion === "TOTAL" && tipoEquipo === "CT") years = 5;
  else if (tipoInspeccion === "TOTAL" && tipoEquipo === "TE") years = 10;
  if (!fechaCargue || !years) return "ACTIVO";
  const due = new Date(fechaCargue);
  due.setUTCFullYear(due.getUTCFullYear() + years);
  return new Date() > due ? "VENCIDO" : "ACTIVO";
}

function parseArgs(argv) {
  const args = {
    excel: null,
    uri: process.env.MONGODB_URI || null,
    db: process.env.MONGODB_LOCAL_DB || "fares",
    apply: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const token = argv[i];
    if (token === "--apply") { args.apply = true; continue; }
    const [flag, inline] = token.split("=");
    const val = inline ?? argv[i + 1];
    if (flag === "--excel" && val) { args.excel = val; if (!inline) i++; }
    if (flag === "--uri" && val) { args.uri = val; if (!inline) i++; }
    if (flag === "--db" && val) { args.db = val; if (!inline) i++; }
  }
  return args;
}

async function parseRows(excelPath) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(excelPath);
  const ws = wb.worksheets[0];

  const rows = [];
  const errors = [];

  for (let r = 2; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);

    const serial       = norm(toCellString(row.getCell(1).value));
    if (!serial) continue;

    const tipoRaw      = norm(toCellString(row.getCell(2).value));
    const capacidad    = norm(toCellString(row.getCell(3).value));
    const inspeccion   = upper(row.getCell(4).value);
    const numFormato   = norm(toCellString(row.getCell(5).value));
    const inspector    = norm(toCellString(row.getCell(6).value));
    const dt           = norm(toCellString(row.getCell(7).value));
    const numCertRaw   = row.getCell(8).value;
    const fechaRealRaw = row.getCell(9).value;
    const fechaEmisRaw = row.getCell(10).value;
    const resultado    = upper(row.getCell(11).value) || "SIN CONCEPTO";
    const empresa      = upper(row.getCell(12).value);
    const usuariosRaw  = norm(toCellString(row.getCell(13).value));
    const direccion    = norm(toCellString(row.getCell(14).value));
    const locacion     = norm(toCellString(row.getCell(15).value));

    // Columnas enriquecidas (presentes solo en algunos Excel)
    const fabricante   = norm(toCellString(row.getCell(16).value));
    const anio         = norm(toCellString(row.getCell(17).value));
    const codigo       = norm(toCellString(row.getCell(18).value));
    const claseUso     = norm(toCellString(row.getCell(19).value));
    const espCuerpo    = norm(toCellString(row.getCell(20).value));
    const espCabeza    = norm(toCellString(row.getCell(21).value));
    const presOper     = norm(toCellString(row.getCell(22).value));
    const presDis      = norm(toCellString(row.getCell(23).value));

    const itemVal = (col) => {
      const v = upper(row.getCell(col).value);
      return ["C", "NC", "NA"].includes(v) ? v : null;
    };

    const itemsEvaluar = {
      hermeticidad:              itemVal(24),
      estadoSoldaduras:          itemVal(25),
      abolladuras:               itemVal(26),
      abombamiento:              itemVal(27),
      areasCorrosionAislada:     itemVal(28),
      areasCorrosionLinea:       itemVal(29),
      areasCorrosionGeneral:     itemVal(30),
      daniosFuego:               itemVal(31),
      sobresanosSoportes:        itemVal(32),
      roscasConexionesAccesorios: itemVal(33),
      estadoTuberias:            itemVal(34),
      proteccionCatodica:        itemVal(35),
      pruebaHidrostatica:        itemVal(36),
      revisionInterna:           itemVal(37),
      medicionEspesores:         itemVal(38),
    };

    const observacion  = norm(toCellString(row.getCell(39).value));
    const resolucion   = norm(toCellString(row.getCell(40).value));
    const articulos    = norm(toCellString(row.getCell(41).value));

    const numCert = Number(toCellString(numCertRaw).replace(/,/g, ""));
    const tipoEquipo   = mapTipoEquipo(tipoRaw);
    const fechaCargue  = parseSpanishDate(fechaEmisRaw);
    const fechaInspeccion = parseSpanishDate(fechaRealRaw);
    const assignedUsers = usuariosRaw
      ? usuariosRaw.split(",").map((u) => u.trim()).filter(Boolean)
      : [];

    const issues = [];
    if (!serial) issues.push("serial vacío");
    if (!tipoEquipo) issues.push(`tipo de equipo inválido: "${tipoRaw}"`);
    if (!["PARCIAL", "TOTAL"].includes(inspeccion)) issues.push(`tipo inspección inválido: "${inspeccion}"`);
    if (!Number.isFinite(numCert)) issues.push("numCert inválido");
    if (!fechaCargue) issues.push("fecha emisión inválida");
    if (!empresa) issues.push("cliente/empresa vacío");

    if (issues.length) {
      errors.push({ fila: r, serial, issues });
      continue;
    }

    // Campos base — solo se aplican en inserción nueva ($setOnInsert)
    const baseDoc = {
      numCert,
      serial,
      fechaCargue,
      empresa,
      assignedUsers,
      tipoEquipo,
      tipoInspeccion: inspeccion,
      status: computeStatus({ fechaCargue, tipoInspeccion: inspeccion, tipoEquipo }),
      isLegacy: true,
      renewedAt: null,
      links: { informes: "#", formatos: "#", certificados: "#", anexos: "#", driveFolder: "#" },
      storage: null,
      createdAt: new Date(),
    };

    // Campos enriquecidos — se aplican siempre ($set), actualizan existentes
    const enrichDoc = {
      resultado,
      "inspeccionCompleta.inspector": inspector || null,
      "inspeccionCompleta.directorTecnico": dt || null,
      "inspeccionCompleta.datosInforme.numeroInforme": String(numCert),
      "inspeccionCompleta.datosInforme.numeroFormato": numFormato || null,
      "inspeccionCompleta.datosInforme.fechaInspeccion": fechaInspeccion ? fechaInspeccion.toISOString() : null,
      "inspeccionCompleta.datosInforme.tipoInspeccion": inspeccion,
      "inspeccionCompleta.datosInforme.resolucion": resolucion || null,
      "inspeccionCompleta.datosInforme.articulos": articulos || null,
      "inspeccionCompleta.datosCliente.cliente": empresa,
      "inspeccionCompleta.informacionItem.capacidad": capacidad || null,
      "inspeccionCompleta.informacionItem.tipoInstalacion": tipoRaw || null,
      "inspeccionCompleta.informacionItem.fabricante": fabricante || null,
      "inspeccionCompleta.informacionItem.anioFabricacion": anio || null,
      "inspeccionCompleta.informacionItem.codigoFabricacion": codigo || null,
      "inspeccionCompleta.informacionItem.claseUso": claseUso || null,
      "inspeccionCompleta.informacionItem.espesorCuerpo": espCuerpo || null,
      "inspeccionCompleta.informacionItem.espesorCabeza": espCabeza || null,
      "inspeccionCompleta.informacionItem.presionOperacion": presOper || null,
      "inspeccionCompleta.informacionItem.presionDisenio": presDis || null,
      "inspeccionCompleta.informacionItem.direccion": direccion || null,
      "inspeccionCompleta.informacionItem.nombreUbicacion": locacion || null,
      "inspeccionCompleta.itemsEvaluar": itemsEvaluar,
      "inspeccionCompleta.reporteEvaluacion.observacionesRecomendaciones": observacion || null,
    };

    rows.push({ fila: r, serial, numCert, baseDoc, enrichDoc });
  }

  return { rows, errors };
}

async function main() {
  const args = parseArgs(process.argv);

  if (!args.excel) {
    console.error("❌ Usa: node scripts/import-legacy-certificates.js --excel <ruta.xlsx> [--apply]");
    process.exit(1);
  }
  if (!fs.existsSync(args.excel)) {
    console.error("❌ Archivo no encontrado:", args.excel);
    process.exit(1);
  }
  if (!args.uri) {
    console.error("❌ Falta MONGODB_URI en .env o --uri");
    process.exit(1);
  }

  const { rows, errors } = await parseRows(args.excel);

  console.log(`\nArchivo: ${path.basename(args.excel)}`);
  console.log(`Filas válidas  : ${rows.length}`);
  console.log(`Filas con error: ${errors.length}`);

  if (errors.length) {
    console.log("\nErrores:");
    for (const e of errors) {
      console.log(`  Fila ${e.fila} [${e.serial}]: ${e.issues.join(", ")}`);
    }
  }

  if (rows.length) {
    console.log("\nPreview (primeras 3 filas):");
    for (const r of rows.slice(0, 3)) {
      const b = r.baseDoc;
      const e = r.enrichDoc;
      console.log(`  Fila ${r.fila} → numCert=${b.numCert} | serial=${b.serial} | empresa=${b.empresa} | tipoEquipo=${b.tipoEquipo} | resultado=${e.resultado} | status=${b.status} | fabricante=${e["inspeccionCompleta.informacionItem.fabricante"]} | hermeticidad=${e["inspeccionCompleta.itemsEvaluar"].hermeticidad}`);
    }
  }

  if (!args.apply) {
    console.log("\nModo DRY-RUN: nada escrito. Agrega --apply para insertar.\n");
    return;
  }

  const client = new MongoClient(args.uri, { serverSelectionTimeoutMS: 15000 });
  await client.connect();

  try {
    const db = client.db(args.db);
    const col = db.collection("certificates");

    // Verificar usuarios en BD
    const allUsers = await db.collection("users")
      .find({}, { projection: { username: 1, empresa: 1 } }).toArray();
    const userMap = new Map();
    for (const u of allUsers) {
      const emp = String(u.empresa || "").trim().toUpperCase();
      if (!userMap.has(emp)) userMap.set(emp, new Set());
      userMap.get(emp).add(u.username);
    }

    let inserted = 0;
    let skipped = 0;
    let warnings = 0;

    for (const item of rows) {
      const { document } = item;
      const empUsers = userMap.get(item.baseDoc.empresa) || new Set();
      const missing = item.baseDoc.assignedUsers.filter((u) => !empUsers.has(u));
      if (missing.length) {
        warnings++;
        console.log(`⚠️  Fila ${item.fila}: usuarios no encontrados para ${item.baseDoc.empresa}: ${missing.join(", ")}`);
      }

      const result = await col.updateOne(
        { empresa: item.baseDoc.empresa, numCert: item.baseDoc.numCert, serial: item.baseDoc.serial },
        {
          $set: item.enrichDoc,
          $setOnInsert: item.baseDoc,
        },
        { upsert: true },
      );

      if (result.upsertedCount > 0) inserted++;
      else skipped++;
    }

    console.log("\n✅ Importación completada:");
    console.log(`  Insertados  : ${inserted}`);
    console.log(`  Ya existían : ${skipped}`);
    console.log(`  Errores omitidos: ${errors.length}`);
    console.log(`  Advertencias usuarios: ${warnings}`);
  } finally {
    await client.close();
  }
}

main().catch((e) => {
  console.error("❌ Error:", e.message);
  process.exit(1);
});
