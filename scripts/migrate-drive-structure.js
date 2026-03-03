/**
 * Script de migración para reorganizar archivos de Drive a nueva estructura por certificado.
 * 
 * Nueva estructura:
 * /<numCert>/
 *   - INF_<empresa>_<numCert>_<serial>_<timestamp>.pdf
 *   - INF_<empresa>_<numCert>_<serial>_<timestamp>.xlsx (Excel)
 *   - CERT_<empresa>_<numCert>_<serial>_<timestamp>.pdf
 *   - ANEXOS_<empresa>_<numCert>_<serial>_<timestamp>.pdf (si existe)
 *   - FOR_<empresa>_<numCert>_<serial>_<timestamp>.pdf (legacy)
 *   /Obsoletos/
 *   /Registros fotográficos/
 *     /Placa/
 *     /Soldaduras/
 *     ... etc
 * 
 * USO:
 *   node scripts/migrate-drive-structure.js --dry-run   # Solo reporta, no mueve nada
 *   node scripts/migrate-drive-structure.js --apply     # Ejecuta la migración
 *   node scripts/migrate-drive-structure.js --apply --limit=10  # Migra solo 10 certificados
 * 
 * IMPORTANTE: Ejecutar primero con --dry-run para revisar el reporte.
 */

import dotenv from "dotenv";
dotenv.config();

import { connect } from "../src/db.js";
import { driveService } from "../src/driveService.js";
import { logger } from "../src/utils.js";

// Parse arguments
const args = process.argv.slice(2);
const isDryRun = args.includes("--dry-run");
const isApply = args.includes("--apply");
const limitArg = args.find(a => a.startsWith("--limit="));
const limit = limitArg ? parseInt(limitArg.split("=")[1], 10) : null;

if (!isDryRun && !isApply) {
  console.log("USO:");
  console.log("  node scripts/migrate-drive-structure.js --dry-run   # Solo reporta");
  console.log("  node scripts/migrate-drive-structure.js --apply     # Ejecuta migración");
  console.log("  node scripts/migrate-drive-structure.js --apply --limit=10  # Limitar");
  process.exit(1);
}

// Mapeo de tipo de link a prefijo
const LINK_PREFIX_MAP = {
  informes: "INF",
  formatos: "FOR",
  certificados: "CERT",
  anexos: "ANEXOS",
};

// Reporte de migración
const report = {
  total: 0,
  processed: 0,
  skipped: 0,
  errors: [],
  moved: [],
  created: [],
  invalidLinks: [],
};

async function getFileCreatedDate(fileId) {
  try {
    const metadata = await driveService.getFileMetadata(fileId);
    return metadata.createdTime ? new Date(metadata.createdTime) : new Date();
  } catch (error) {
    return new Date();
  }
}

function formatDateForFilename(date) {
  const d = date instanceof Date ? date : new Date(date);
  const day = String(d.getDate()).padStart(2, "0");
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const year = String(d.getFullYear()).slice(-2);
  return `${day}-${month}-${year}`;
}

async function migrateCertificate(cert, db) {
  const numCert = cert.numCert;
  const empresa = String(cert.empresa || "").replace(/[^a-zA-Z0-9]/g, "_").toUpperCase();
  const serial = String(cert.serial || "").replace(/[^a-zA-Z0-9]/g, "_").toUpperCase();
  
  console.log(`\n[${numCert}] Procesando certificado: ${empresa} - ${serial}`);
  
  // Verificar si ya tiene storage (ya migrado)
  if (cert.storage?.rootFolderId) {
    console.log(`  [SKIP] Ya tiene estructura de carpetas`);
    report.skipped++;
    return;
  }
  
  try {
    // 1. Crear árbol de carpetas
    console.log(`  Creando árbol de carpetas...`);
    let storage;
    if (!isDryRun) {
      storage = await driveService.ensureCertificateFolderTree(numCert);
      report.created.push({ numCert, folderId: storage.rootFolderId });
    } else {
      storage = { rootFolderId: "DRY_RUN", obsoletosFolderId: "DRY_RUN" };
      console.log(`  [DRY-RUN] Se crearía carpeta /${numCert}/`);
    }
    
    // 2. Mover y renombrar archivos existentes
    const links = cert.links || {};
    const newLinks = { ...links };
    const timestamp = Date.now();
    
    for (const [linkKey, prefix] of Object.entries(LINK_PREFIX_MAP)) {
      const link = links[linkKey];
      if (!link || link === "#") continue;
      
      const fileId = driveService.extractFileIdFromLink(link);
      if (!fileId) {
        console.log(`  [WARN] Link inválido para ${linkKey}: ${link}`);
        report.invalidLinks.push({ numCert, linkKey, link });
        continue;
      }
      
      try {
        // Obtener metadata del archivo
        const metadata = await driveService.getFileMetadata(fileId);
        const originalName = metadata.name || "archivo";
        const createdDate = metadata.createdTime ? new Date(metadata.createdTime) : new Date();
        
        // Determinar extensión
        const extMatch = originalName.match(/(\.[^.]+)$/);
        const ext = extMatch ? extMatch[1] : ".pdf";
        
        // Nuevo nombre con prefijo
        const newName = `${prefix}_${empresa}_${numCert}_${serial}_${timestamp}${ext}`;
        
        console.log(`  [${linkKey}] ${originalName} -> ${newName}`);
        
        if (!isDryRun) {
          // Mover a carpeta del certificado
          await driveService.moveFile(fileId, storage.rootFolderId);
          
          // Renombrar con prefijo
          await driveService.renameFile(fileId, newName);
          
          report.moved.push({
            numCert,
            linkKey,
            fileId,
            originalName,
            newName,
          });
        } else {
          console.log(`  [DRY-RUN] Se movería y renombraría`);
        }
        
      } catch (error) {
        console.log(`  [ERROR] No se pudo procesar ${linkKey}: ${error.message}`);
        report.errors.push({
          numCert,
          linkKey,
          fileId,
          error: error.message,
        });
      }
    }
    
    // 3. Actualizar documento en DB
    if (!isDryRun) {
      const updates = {
        storage,
        "links.driveFolder": `https://drive.google.com/drive/folders/${storage.rootFolderId}`,
      };
      
      await db.collection("certificates").updateOne(
        { _id: cert._id },
        { $set: updates }
      );
      
      console.log(`  [OK] Documento actualizado en DB`);
    }
    
    report.processed++;
    
  } catch (error) {
    console.log(`  [ERROR FATAL] ${error.message}`);
    report.errors.push({
      numCert,
      error: error.message,
      fatal: true,
    });
  }
}

async function main() {
  console.log("=".repeat(60));
  console.log("MIGRACIÓN DE ESTRUCTURA DE DRIVE");
  console.log(`Modo: ${isDryRun ? "DRY-RUN (solo reporte)" : "APLICAR CAMBIOS"}`);
  if (limit) console.log(`Límite: ${limit} certificados`);
  console.log("=".repeat(60));
  
  try {
    const db = await connect();
    
    // Obtener certificados sin storage
    const query = {
      $or: [
        { storage: { $exists: false } },
        { "storage.rootFolderId": { $exists: false } },
      ],
    };
    
    let cursor = db.collection("certificates").find(query).sort({ numCert: 1 });
    if (limit) {
      cursor = cursor.limit(limit);
    }
    
    const certificates = await cursor.toArray();
    report.total = certificates.length;
    
    console.log(`\nCertificados a procesar: ${certificates.length}`);
    
    if (certificates.length === 0) {
      console.log("No hay certificados pendientes de migrar.");
      process.exit(0);
    }
    
    // Procesar cada certificado
    for (const cert of certificates) {
      await migrateCertificate(cert, db);
    }
    
    // Imprimir reporte final
    console.log("\n" + "=".repeat(60));
    console.log("REPORTE FINAL");
    console.log("=".repeat(60));
    console.log(`Total certificados: ${report.total}`);
    console.log(`Procesados: ${report.processed}`);
    console.log(`Saltados (ya migrados): ${report.skipped}`);
    console.log(`Errores: ${report.errors.length}`);
    console.log(`Links inválidos: ${report.invalidLinks.length}`);
    
    if (report.errors.length > 0) {
      console.log("\nERRORES:");
      report.errors.forEach(e => {
        console.log(`  - Cert ${e.numCert}: ${e.linkKey || "fatal"} - ${e.error}`);
      });
    }
    
    if (report.invalidLinks.length > 0) {
      console.log("\nLINKS INVÁLIDOS:");
      report.invalidLinks.forEach(e => {
        console.log(`  - Cert ${e.numCert}: ${e.linkKey} = ${e.link}`);
      });
    }
    
    if (isDryRun) {
      console.log("\n[DRY-RUN] No se realizaron cambios. Ejecuta con --apply para aplicar.");
    } else {
      console.log("\n[OK] Migración completada.");
    }
    
    process.exit(0);
    
  } catch (error) {
    console.error("\n[FATAL] Error en migración:", error);
    process.exit(1);
  }
}

main();
