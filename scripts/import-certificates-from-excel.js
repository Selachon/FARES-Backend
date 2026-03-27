import ExcelJS from "exceljs";
import dotenv from "dotenv";
import { MongoClient } from "mongodb";
import fs from "fs";
import path from "path";

dotenv.config();

const monthMap = {
  enero: 0,
  febrero: 1,
  marzo: 2,
  abril: 3,
  mayo: 4,
  junio: 5,
  julio: 6,
  agosto: 7,
  septiembre: 8,
  setiembre: 8,
  octubre: 9,
  noviembre: 10,
  diciembre: 11,
};

const headerAliases = {
  numCert: ["Número Certificado", "Numero Certificado", "numCert", "num cert"],
  serial: ["Serial", "serie"],
  fechaCargue: ["Fecha de cargue", "Fecha Cargue", "fechaCargue"],
  resultado: ["Resultado", "resultado"],
  empresa: ["Empresa", "empresa"],
  assignedUsers: ["Usuarios asignados", "Usuario asignado", "assignedUsers"],
  tipoEquipo: ["Tipo de Equipo", "tipoEquipo"],
  tipoInspeccion: ["Tipo de Inspección", "Tipo de Inspeccion", "tipoInspeccion"],
};

function normalizeText(value) {
  return String(value ?? "").trim();
}

function uppercaseText(value) {
  return normalizeText(value).toUpperCase();
}

function toCellString(value) {
  if (value == null) return "";

  if (typeof value === "string") return value;

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (typeof value === "object") {
    if (typeof value.text === "string") return value.text;
    if (Array.isArray(value.richText)) {
      return value.richText.map((part) => part?.text || "").join("");
    }
    if (value.result != null) return toCellString(value.result);
    if (value.formula && value.result == null) return "";
    if (value.hyperlink && value.text) return String(value.text);
  }

  return String(value);
}

function toNumber(value) {
  const raw = normalizeText(toCellString(value));
  if (!raw) return null;
  const normalized = raw.replace(/,/g, "");
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function excelSerialToDate(serial) {
  if (!Number.isFinite(serial)) return null;
  const excelEpochMs = Date.UTC(1899, 11, 30);
  const ms = Math.round(serial * 86400000);
  const date = new Date(excelEpochMs + ms);
  return Number.isNaN(date.getTime()) ? null : date;
}

function parseSpanishDate(value) {
  if (!value && value !== 0) return null;

  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value;
  }

  if (typeof value === "number") {
    return excelSerialToDate(value);
  }

  const raw = normalizeText(toCellString(value));
  if (!raw) return null;

  const directDate = new Date(raw);
  if (!Number.isNaN(directDate.getTime())) return directDate;

  const normalized = raw
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

  const match = normalized.match(/^(\d{1,2})\s+de\s+([a-z]+)\s+de\s+(\d{4})$/);
  if (!match) return null;

  const day = Number(match[1]);
  const monthName = match[2];
  const year = Number(match[3]);
  const month = monthMap[monthName];

  if (!Number.isInteger(day) || month === undefined || !Number.isInteger(year)) {
    return null;
  }

  return new Date(Date.UTC(year, month, day, 12, 0, 0));
}

function yearsToExpire(tipoInspeccion, tipoEquipo) {
  if (tipoInspeccion === "PARCIAL") return 1;
  if (tipoInspeccion === "TOTAL" && tipoEquipo === "CT") return 5;
  if (tipoInspeccion === "TOTAL" && tipoEquipo === "TE") return 10;
  return null;
}

function computeStatus({ fechaCargue, tipoInspeccion, tipoEquipo }) {
  const years = yearsToExpire(tipoInspeccion, tipoEquipo);

  if (!fechaCargue || !years) {
    return "ACTIVO";
  }

  const due = new Date(fechaCargue.getTime());
  due.setUTCFullYear(due.getUTCFullYear() + years);
  return new Date() > due ? "VENCIDO" : "ACTIVO";
}

function parseAssignedUsers(raw) {
  const text = normalizeText(toCellString(raw));
  if (!text) return [];
  return text
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeHeader(value) {
  return normalizeText(value)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function buildHeaderLookup(worksheet) {
  const row = worksheet.getRow(1);
  const map = new Map();

  row.eachCell((cell, columnIndex) => {
    const key = normalizeHeader(toCellString(cell.value));
    if (key) map.set(key, columnIndex);
  });

  const resolved = {};
  for (const [field, aliases] of Object.entries(headerAliases)) {
    const foundAlias = aliases.find((alias) => map.has(normalizeHeader(alias)));
    resolved[field] = foundAlias ? map.get(normalizeHeader(foundAlias)) : null;
  }

  return resolved;
}

function parseArgs(argv) {
  const args = {
    excel: null,
    dir: null,
    uri: process.env.MONGODB_URI || null,
    db: process.env.MONGODB_LOCAL_DB || "fares",
    collection: "certificates",
    sheet: null,
    apply: false,
  };

  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i];

    if (token === "--apply") {
      args.apply = true;
      continue;
    }

    if (token === "--dry-run") {
      args.apply = false;
      continue;
    }

    const [flag, inlineValue] = token.split("=");
    const value = inlineValue ?? argv[i + 1];

    if (flag === "--excel" && value) {
      args.excel = value;
      if (inlineValue == null) i += 1;
      continue;
    }
    if (flag === "--dir" && value) {
      args.dir = value;
      if (inlineValue == null) i += 1;
      continue;
    }
    if (flag === "--uri" && value) {
      args.uri = value;
      if (inlineValue == null) i += 1;
      continue;
    }
    if (flag === "--db" && value) {
      args.db = value;
      if (inlineValue == null) i += 1;
      continue;
    }
    if (flag === "--collection" && value) {
      args.collection = value;
      if (inlineValue == null) i += 1;
      continue;
    }
    if (flag === "--sheet" && value) {
      args.sheet = value;
      if (inlineValue == null) i += 1;
      continue;
    }
    if (flag === "--help" || flag === "-h") {
      printHelp();
      process.exit(0);
    }
  }

  return args;
}

function printHelp() {
  console.log(`Uso:
  node scripts/import-certificates-from-excel.js (--excel <ruta.xlsx> | --dir <carpeta>) [--apply] [--uri <mongodb-uri>] [--db <nombre-db>] [--sheet <nombre-hoja>] [--collection <nombre-coleccion>]

Opciones:
  --excel       Ruta del archivo Excel (requerido)
  --dir         Carpeta con archivos .xlsx (alternativa a --excel)
  --apply       Ejecuta insercion/upsert real en MongoDB
  --dry-run     Solo valida y simula (default)
  --uri         URI de MongoDB (default: MONGODB_URI del .env)
  --db          Nombre de base de datos (default: fares)
  --sheet       Nombre de hoja; si no se indica usa la primera
  --collection  Coleccion destino (default: certificates)
  --help, -h    Ver ayuda
`);
}

function collectExcelFiles({ excel, dir }) {
  if (excel) {
    if (!fs.existsSync(excel)) {
      throw new Error(`No existe el archivo Excel: ${excel}`);
    }
    return [excel];
  }

  if (!dir) {
    return [];
  }

  if (!fs.existsSync(dir)) {
    throw new Error(`No existe la carpeta: ${dir}`);
  }

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile() && /\.xlsx$/i.test(entry.name))
    .map((entry) => path.join(dir, entry.name))
    .sort((a, b) => a.localeCompare(b, "es"));

  if (files.length === 0) {
    throw new Error(`No se encontraron archivos .xlsx en: ${dir}`);
  }

  return files;
}

async function parseWorkbookRows({ excelPath, sheetName }) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(excelPath);

  const worksheet = sheetName
    ? workbook.getWorksheet(sheetName)
    : workbook.worksheets[0];

  if (!worksheet) {
    throw new Error(`No se encontro la hoja en el archivo: ${excelPath}`);
  }

  const header = buildHeaderLookup(worksheet);
  const missingFields = Object.entries(header)
    .filter(([, column]) => !column)
    .map(([field]) => field);

  if (missingFields.length > 0) {
    throw new Error(
      `Columnas requeridas faltantes en ${path.basename(excelPath)}: ${missingFields.join(", ")}`,
    );
  }

  const rows = [];
  const errors = [];

  for (let rowNumber = 2; rowNumber <= worksheet.rowCount; rowNumber += 1) {
    const row = worksheet.getRow(rowNumber);
    const rawValues = {
      numCert: row.getCell(header.numCert).value,
      serial: row.getCell(header.serial).value,
      fechaCargue: row.getCell(header.fechaCargue).value,
      resultado: row.getCell(header.resultado).value,
      empresa: row.getCell(header.empresa).value,
      assignedUsers: row.getCell(header.assignedUsers).value,
      tipoEquipo: row.getCell(header.tipoEquipo).value,
      tipoInspeccion: row.getCell(header.tipoInspeccion).value,
    };

    const isBlank = Object.values(rawValues).every((value) => {
      const text = normalizeText(toCellString(value));
      return !text;
    });

    if (isBlank) continue;

    const numCert = toNumber(rawValues.numCert);
    const serial = normalizeText(toCellString(rawValues.serial));
    const fechaCargue = parseSpanishDate(rawValues.fechaCargue);
    const resultado = uppercaseText(toCellString(rawValues.resultado)) || "CUMPLE";
    const empresa = uppercaseText(toCellString(rawValues.empresa));
    const assignedUsers = parseAssignedUsers(rawValues.assignedUsers);
    const tipoEquipo = uppercaseText(toCellString(rawValues.tipoEquipo));
    const tipoInspeccion = uppercaseText(toCellString(rawValues.tipoInspeccion));

    const issues = [];

    if (!Number.isFinite(numCert)) issues.push("numCert invalido");
    if (!serial) issues.push("serial vacio");
    if (!fechaCargue) issues.push("fechaCargue invalida");
    if (!empresa) issues.push("empresa vacia");
    if (assignedUsers.length === 0) issues.push("assignedUsers vacio");
    if (!["TE", "CT"].includes(tipoEquipo)) issues.push("tipoEquipo invalido");
    if (!["PARCIAL", "TOTAL"].includes(tipoInspeccion)) issues.push("tipoInspeccion invalido");

    if (issues.length > 0) {
      errors.push({ file: excelPath, row: rowNumber, issues });
      continue;
    }

    const document = {
      numCert,
      serial,
      fechaCargue,
      resultado,
      empresa,
      assignedUsers,
      tipoEquipo,
      tipoInspeccion,
      status: computeStatus({ fechaCargue, tipoInspeccion, tipoEquipo }),
      renewedAt: null,
      links: {
        informes: "#",
        formatos: "#",
        certificados: "#",
        anexos: "#",
        driveFolder: "#",
      },
      storage: null,
      createdAt: new Date(),
    };

    rows.push({ file: excelPath, rowNumber, document });
  }

  return {
    worksheetName: worksheet.name,
    rows,
    errors,
  };
}

async function main() {
  const args = parseArgs(process.argv);

  if (!args.excel && !args.dir) {
    console.error("❌ Debes enviar --excel <ruta.xlsx> o --dir <carpeta>");
    printHelp();
    process.exit(1);
  }

  if (!args.uri) {
    console.error("❌ Falta URI de MongoDB. Usa --uri o define MONGODB_URI en .env");
    process.exit(1);
  }

  const files = collectExcelFiles({ excel: args.excel, dir: args.dir });
  const rows = [];
  const errors = [];
  for (const excelPath of files) {
    const parsed = await parseWorkbookRows({ excelPath, sheetName: args.sheet });
    rows.push(...parsed.rows);
    errors.push(...parsed.errors);

    console.log(`\nArchivo: ${excelPath}`);
    console.log(`Hoja: ${parsed.worksheetName}`);
    console.log(`- Filas validas: ${parsed.rows.length}`);
    console.log(`- Filas con error: ${parsed.errors.length}`);
  }

  console.log(`\nTotal archivos procesados: ${files.length}`);
  console.log(`Filas utiles detectadas: ${rows.length + errors.length}`);
  console.log(`Filas validas: ${rows.length}`);
  console.log(`Filas con error: ${errors.length}`);

  if (errors.length > 0) {
    console.log("\nPrimeros errores:");
    for (const error of errors.slice(0, 10)) {
      console.log(`- ${error.file} fila ${error.row}: ${error.issues.join(", ")}`);
    }
  }

  if (!args.apply) {
    console.log("\nModo DRY-RUN: no se escribio nada en MongoDB. Usa --apply para ejecutar.");
    return;
  }

  const client = new MongoClient(args.uri, { serverSelectionTimeoutMS: 15000 });
  await client.connect();

  try {
    const db = client.db(args.db);
    const collection = db.collection(args.collection);

    const usersByEmpresa = await db
      .collection("users")
      .find({}, { projection: { _id: 0, username: 1, empresa: 1 } })
      .toArray();

    const userMap = new Map();
    for (const user of usersByEmpresa) {
      const empresa = uppercaseText(user.empresa);
      if (!userMap.has(empresa)) userMap.set(empresa, new Set());
      userMap.get(empresa).add(normalizeText(user.username));
    }

    let inserted = 0;
    let alreadyExisted = 0;
    let warnings = 0;

    for (const item of rows) {
      const { document } = item;

      const empresaUsers = userMap.get(document.empresa) || new Set();
      const missingUsers = document.assignedUsers.filter((username) => !empresaUsers.has(username));

      if (missingUsers.length > 0) {
        warnings += 1;
        console.log(
          `⚠️  Fila ${item.rowNumber}: usuarios no encontrados para ${document.empresa}: ${missingUsers.join(", ")}`,
        );
      }

      const result = await collection.updateOne(
        {
          empresa: document.empresa,
          numCert: document.numCert,
          serial: document.serial,
        },
        { $setOnInsert: document },
        { upsert: true },
      );

      if (result.upsertedCount > 0) inserted += 1;
      else alreadyExisted += 1;
    }

    console.log("\nResultado de importacion:");
    console.log(`- Insertados nuevos: ${inserted}`);
    console.log(`- Ya existentes: ${alreadyExisted}`);
    console.log(`- Filas invalidas omitidas: ${errors.length}`);
    console.log(`- Advertencias de usuarios faltantes: ${warnings}`);
  } finally {
    await client.close();
  }
}

main().catch((error) => {
  console.error("❌ Error importando certificados desde Excel:", error.message || error);
  process.exit(1);
});
