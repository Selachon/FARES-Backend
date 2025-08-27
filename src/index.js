import express from "express";
import cors from "cors";
import morgan from "morgan";
import multer from "multer";
import dotenv from "dotenv";
import path from "node:path";
import { google } from "googleapis";
import fs from "node:fs";
import { ObjectId } from "mongodb";
import { connect } from "./db.js";
import bcrypt from "bcryptjs";
dotenv.config();

const app = express();
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use(morgan("dev"));

const upload = multer({ dest: "uploads/" });

// ====== OAuth2 (usuario tuyo con refresh_token) ======
const oauth2 = new google.auth.OAuth2(
  process.env.GOOGLE_OAUTH_CLIENT_ID,
  process.env.GOOGLE_OAUTH_CLIENT_SECRET
);
oauth2.setCredentials({
  refresh_token: process.env.GOOGLE_OAUTH_REFRESH_TOKEN,
});
// Calentar el token de acceso en el arranque para evitar el fallo del primer intento
(async function warmGoogleAuth() {
  try {
    await oauth2.getAccessToken();
    console.log("[Google OAuth] warm-up OK");
  } catch (e) {
    console.error("[Google OAuth] warm-up failed (continuo igual):", e?.message || e);
  }
})();

const drive = google.drive({ version: "v3", auth: oauth2 });

// ====== Admin guard ======
function requireAdmin(req, res, next) {
  if ((req.headers["x-role"] || "").toUpperCase() !== "ADMIN") {
    return res.status(403).json({ message: "Solo ADMIN" });
  }
  next();
}

// ✅ MANTENER ESTAS (Mongo) — usan requireAdmin y guardan en collection "config"
app.get("/api/admin/drive-folders", requireAdmin, async (req, res) => {
  const db = await connect();
  const doc = await db.collection("config").findOne({ key: "driveFolders" });
  const fallback = {
    INF: process.env.DRIVE_FOLDER_INF || "",
    FOR: process.env.DRIVE_FOLDER_FOR || "",
    CERT: process.env.DRIVE_FOLDER_CERT || "",
  };
  res.json(doc?.value || fallback);
});

app.put("/api/admin/drive-folders", requireAdmin, async (req, res) => {
  const body = req.body || {};

  // Mezcla incremental: lee lo actual y sobreescribe solo lo que venga
  const db = await connect();
  const currentDoc = await db.collection("config").findOne({ key: "driveFolders" });
  const current = currentDoc?.value || {
    INF: process.env.DRIVE_FOLDER_INF || "",
    FOR: process.env.DRIVE_FOLDER_FOR || "",
    CERT: process.env.DRIVE_FOLDER_CERT || "",
  };
  const wanted = {
    INF: typeof body.INF === "string" ? body.INF : current.INF,
    FOR: typeof body.FOR === "string" ? body.FOR : current.FOR,
    CERT: typeof body.CERT === "string" ? body.CERT : current.CERT,
  };

  // (Opcional pero recomendable) validar que los IDs sean carpetas válidas
  for (const [k, id] of Object.entries(wanted)) {
    if (!id) continue;
    try {
      const info = await drive.files.get({
        fileId: id,
        fields: "id,name,mimeType",
        supportsAllDrives: true,
      });
      if (info.data.mimeType !== "application/vnd.google-apps.folder") {
        return res.status(400).json({ message: `${k} no es una carpeta` });
      }
    } catch {
      return res.status(400).json({ message: `ID inválido en ${k}` });
    }
  }

  await db.collection("config").updateOne(
    { key: "driveFolders" },
    { $set: { key: "driveFolders", value: wanted, updatedAt: new Date() } },
    { upsert: true }
  );
  res.json(wanted);
});


app.get("/api/drive/fileinfo", requireAdmin, async (req, res) => {
  const id = req.query.id;
  if (!id) return res.status(400).json({ message: "Falta id" });
  try {
    const info = await drive.files.get({
      fileId: id,
      fields: "id,name,parents,mimeType,driveId",
      supportsAllDrives: true,
    });
    res.json(info.data);
  } catch {
    res.status(404).json({ message: "No se encontró la carpeta" });
  }
});

// ====== Auth ======
app.get("/api/auth/users", async (req, res) => {
  const db = await connect();
  const users = await db.collection("users")
    .find({}, { projection: { _id: 0, password: 0 } })
    .toArray();
  res.json(users);
});

app.post("/api/auth/login", async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password)
    return res.status(400).json({ message: "Usuario y clave obligatorios" });

  const db = await connect();
  const user = await db.collection("users").findOne({ username });
  if (!user) return res.status(404).json({ message: "Usuario no existe" });

  const stored = user.password || "";
  // Si está hasheado, comparamos con bcrypt. Si no, comparamos plano.
  const looksHashed = stored.startsWith("$2a$") || stored.startsWith("$2b$");
  const ok = looksHashed ? await bcrypt.compare(password, stored) : stored === password;

  if (!ok) return res.status(401).json({ message: "Clave incorrecta" });

  res.json({ username: user.username, role: user.role, empresa: user.empresa });
});


// ====== Helpers Drive (retry una vez ante 401/invalid_grant) ======
async function driveGetWithRetry(params) {
  try {
    return await drive.files.get(params);
  } catch (e) {
    const status = e?.response?.status;
    const errCode = e?.response?.data?.error || e?.errors?.[0]?.reason;
    if (status === 401 || errCode === "invalid_grant") {
      // fuerza refresco de access_token y reintenta
      await oauth2.getAccessToken().catch(() => {});
      return await drive.files.get(params);
    }
    throw e;
  }
}

async function driveCreateWithRetry(params) {
  try {
    return await drive.files.create(params);
  } catch (e) {
    const status = e?.response?.status;
    const errCode = e?.response?.data?.error || e?.errors?.[0]?.reason;
    if (status === 401 || errCode === "invalid_grant") {
      await oauth2.getAccessToken().catch(() => {});
      return await drive.files.create(params);
    }
    throw e;
  }
}

// ====== Helpers Drive ======
async function uploadToDrive({ localPath, fileName, mimeType, appProperties = {}, folderId }) {
  const targetFolder = folderId || process.env.DRIVE_PARENT_FOLDER_ID;
  if (!targetFolder) {
    throw new Error("No se configuró carpeta de destino (DRIVE_PARENT_FOLDER_ID o DRIVE_FOLDER_*)");
  }

  const media = { mimeType, body: fs.createReadStream(localPath) };

  try {
    await driveGetWithRetry({
      fileId: targetFolder,
      fields: "id,name,driveId,mimeType",
      supportsAllDrives: true,
    });
  } catch (e) {
    throw new Error("No hay acceso a la carpeta destino (revisa OAuth y el ID)");
  }

  const res = await driveCreateWithRetry({
    requestBody: {
      name: fileName,
      parents: [targetFolder],
      mimeType,
      description: [
        `Usuario(s): ${appProperties.Usuario || ""}`,
        `NumCert: ${appProperties.NumCert || ""}`,
        `Serial: ${appProperties.Serial || ""}`,
      ].join(" | "),
    },
    media,
    fields: "id, webViewLink, webContentLink",
    supportsAllDrives: true,
  });
  return res.data;
}


function pick(arr) {
  return Array.isArray(arr) && arr.length > 0 ? arr[0] : null;
}

// ====== Certificates ======
app.get("/api/certificates", async (req, res) => {
  const db = await connect();
  const certs = await db
    .collection("certificates")
    .find({})
    .sort({ numCert: 1 })
    .toArray();

  // Devuelve id (string) y normaliza fecha
  res.json(
    certs.map((c) => ({
      id: c._id?.toString?.() || c.id, // por si hay registros antiguos sin _id expuesto
      numCert: c.numCert,
      serial: c.serial,
      fechaCargue: new Date(c.fechaCargue).toISOString(),
      resultado: c.resultado,
      empresa: c.empresa,
      assignedUsers: c.assignedUsers,
      links: c.links || { informes: "#", formatos: "#", certificados: "#" },
    }))
  );
});

app.post(
  "/api/certificates",
  upload.fields([{ name: "informes" }, { name: "formatos" }, { name: "certificados" }]),
  async (req, res) => {
    const { numCert, serial, fechaCargue, empresa, assignedUsers: assigned, resultado = "CUMPLE",
      folderINF, folderFOR, folderCERT } = req.body || {};

    const assignedUsers = Array.isArray(assigned) ? assigned : String(assigned || "").split(",").filter(Boolean);

    if (!numCert || !serial || !empresa || assignedUsers.length === 0) {
      return res.status(400).json({ message: "Campos requeridos: numCert, serial, empresa, assignedUsers" });
    }

    const db = await connect();
    const users = await db.collection("users").find({ username: { $in: assignedUsers } }).toArray();
    if (users.length !== assignedUsers.length || users.some((u) => u.empresa !== empresa)) {
      return res.status(400).json({ message: "Los usuarios asignados deben existir y pertenecer a la Empresa seleccionada" });
    }

    const meta = { Usuario: assignedUsers.join(","), NumCert: String(numCert), Serial: String(serial) };
    const files = req.files || {};
    const fInf = pick(files.informes);
    const fFor = pick(files.formatos);
    const fCert = pick(files.certificados);

    // Prioridades de carpeta
    const dbCfg = await db.collection("config").findOne({ key: "driveFolders" });
    const cfg = dbCfg?.value || {};
    const folderInf = folderINF || cfg.INF || process.env.DRIVE_FOLDER_INF || process.env.DRIVE_PARENT_FOLDER_ID;
    const folderFor = folderFOR || cfg.FOR || process.env.DRIVE_FOLDER_FOR || process.env.DRIVE_PARENT_FOLDER_ID;
    const folderCert = folderCERT || cfg.CERT || process.env.DRIVE_FOLDER_CERT || process.env.DRIVE_PARENT_FOLDER_ID;

    const stamp = Date.now();
    const makeName = (orig) => `${empresa}_${numCert}_${serial}_${stamp}${path.extname(orig || ".pdf")}`;

    let linkInf = null, linkFor = null, linkCert = null;
    try {
      if (fInf) linkInf = await uploadToDrive({ localPath: fInf.path, fileName: makeName(fInf.originalname), mimeType: fInf.mimetype || "application/pdf", appProperties: meta, folderId: folderInf });
      if (fFor) linkFor = await uploadToDrive({ localPath: fFor.path, fileName: makeName(fFor.originalname), mimeType: fFor.mimetype || "application/pdf", appProperties: meta, folderId: folderFor });
      if (fCert) linkCert = await uploadToDrive({ localPath: fCert.path, fileName: makeName(fCert.originalname), mimeType: fCert.mimetype || "application/pdf", appProperties: meta, folderId: folderCert });
    } catch (e) {
      console.error("Error subiendo a Drive:", e);
      return res.status(500).json({ message: "Error subiendo archivos a Google Drive" });
    }

    const links = {
      informes: linkInf?.webViewLink || "#",
      formatos: linkFor?.webViewLink || "#",
      certificados: linkCert?.webViewLink || "#",
    };

    const doc = {
      numCert: Number(numCert),
      serial,
      fechaCargue: new Date(fechaCargue || new Date()),
      resultado,
      empresa,
      assignedUsers,
      links,
    };

    const result = await db.collection("certificates").insertOne(doc);
    res.json({ id: result.insertedId.toString(), ...doc });
  }
);

// ====== UPDATE (solo ADMIN): reemplaza campos y archivos adjuntos ======
app.put(
  "/api/certificates/:id",
  requireAdmin,
  upload.fields([{ name: "informes" }, { name: "formatos" }, { name: "certificados" }]),
  async (req, res) => {
    const { id } = req.params;
    const db = await connect();

    // Buscar doc
    let _id;
    try {
      _id = new ObjectId(id);
    } catch {
      return res.status(400).json({ message: "ID inválido" });
    }
    const existing = await db.collection("certificates").findOne({ _id });
    if (!existing) return res.status(404).json({ message: "No existe el certificado" });

    // Campos editables
    const {
      numCert,
      serial,
      fechaCargue,
      empresa,
      assignedUsers: assigned,
      resultado,
      folderINF,
      folderFOR,
      folderCERT,
    } = req.body || {};

    const updates = {};
    if (numCert !== undefined) updates.numCert = Number(numCert);
    if (serial !== undefined) updates.serial = String(serial);
    if (resultado !== undefined) updates.resultado = resultado;
    if (fechaCargue !== undefined) updates.fechaCargue = new Date(fechaCargue);
    if (empresa !== undefined) updates.empresa = empresa;

    let assignedUsers = existing.assignedUsers;
    if (assigned !== undefined) {
      assignedUsers = Array.isArray(assigned) ? assigned : String(assigned || "").split(",").filter(Boolean);
      updates.assignedUsers = assignedUsers;
    }

    // Validación empresa/usuarios si cambian
    const effectiveEmpresa = updates.empresa ?? existing.empresa;
    const effectiveUsers = updates.assignedUsers ?? existing.assignedUsers;
    if (effectiveUsers) {
      const users = await db.collection("users").find({ username: { $in: effectiveUsers } }).toArray();
      if (users.length !== effectiveUsers.length || users.some((u) => u.empresa !== effectiveEmpresa)) {
        return res.status(400).json({ message: "Los usuarios asignados deben existir y pertenecer a la Empresa seleccionada" });
      }
    }

    // Reemplazo de archivos (opcional)
    const files = req.files || {};
    const fInf = pick(files.informes);
    const fFor = pick(files.formatos);
    const fCert = pick(files.certificados);

    // meta recalculada si cambian num/serial/users
    const meta = {
      Usuario: (updates.assignedUsers ?? existing.assignedUsers).join(","),
      NumCert: String(updates.numCert ?? existing.numCert),
      Serial: String(updates.serial ?? existing.serial),
    };

    // Prioridad de carpetas
    const dbCfg = await db.collection("config").findOne({ key: "driveFolders" });
    const cfg = dbCfg?.value || {};
    const folderInf = folderINF || cfg.INF || process.env.DRIVE_FOLDER_INF || process.env.DRIVE_PARENT_FOLDER_ID;
    const folderFor = folderFOR || cfg.FOR || process.env.DRIVE_FOLDER_FOR || process.env.DRIVE_PARENT_FOLDER_ID;
    const folderCert = folderCERT || cfg.CERT || process.env.DRIVE_FOLDER_CERT || process.env.DRIVE_PARENT_FOLDER_ID;

    const stamp = Date.now();
    const makeName = (orig) => `${effectiveEmpresa}_${updates.numCert ?? existing.numCert}_${updates.serial ?? existing.serial}_${stamp}${path.extname(orig || ".pdf")}`;

    const newLinks = { ...(existing.links || {}) };
    try {
      if (fInf) {
        const up = await uploadToDrive({ localPath: fInf.path, fileName: makeName(fInf.originalname), mimeType: fInf.mimetype || "application/pdf", appProperties: meta, folderId: folderInf });
        newLinks.informes = up.webViewLink || newLinks.informes || "#";
      }
      if (fFor) {
        const up = await uploadToDrive({ localPath: fFor.path, fileName: makeName(fFor.originalname), mimeType: fFor.mimetype || "application/pdf", appProperties: meta, folderId: folderFor });
        newLinks.formatos = up.webViewLink || newLinks.formatos || "#";
      }
      if (fCert) {
        const up = await uploadToDrive({ localPath: fCert.path, fileName: makeName(fCert.originalname), mimeType: fCert.mimetype || "application/pdf", appProperties: meta, folderId: folderCert });
        newLinks.certificados = up.webViewLink || newLinks.certificados || "#";
      }
    } catch (e) {
      console.error("Error reemplazando archivos en Drive:", e);
      return res.status(500).json({ message: "Error subiendo archivos a Google Drive" });
    }
    updates.links = newLinks;

    await db.collection("certificates").updateOne({ _id }, { $set: updates });
    const updated = await db.collection("certificates").findOne({ _id });

    res.json({
      id: updated._id.toString(),
      numCert: updated.numCert,
      serial: updated.serial,
      fechaCargue: new Date(updated.fechaCargue).toISOString(),
      resultado: updated.resultado,
      empresa: updated.empresa,
      assignedUsers: updated.assignedUsers,
      links: updated.links,
    });
  }
);

app.delete("/api/certificates/bulk", async (req, res) => {
  try {
    const { items } = req.body || {};
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ message: "Lista vacía" });
    }

    const db = await connect();
    const result = await db.collection("certificates").deleteMany({
      $or: items.map((c) => ({
        empresa: c.empresa,
        numCert: Number(c.numCert),
        serial: c.serial
      }))
    });

    res.json({ ok: true, deleted: result.deletedCount });
  } catch (err) {
    console.error("Error eliminando certificados:", err);
    res.status(500).json({ message: "Error interno eliminando certificados" });
  }
});

app.put("/api/admin/users/password", requireAdmin, async (req, res) => {
  try {
    const { username, newPassword } = req.body || {};
    if (!username || !newPassword) {
      return res.status(400).json({ message: "username y newPassword son obligatorios" });
    }
    
    const db = await connect();
    const user = await db.collection("users").findOne({ username });
    if (!user) return res.status(404).json({ message: "Usuario no existe" });
    
    const salt = await bcrypt.genSalt(10);
    const hash = await bcrypt.hash(newPassword, salt);
    
    await db.collection("users").updateOne(
      { username },
      { $set: { password: hash } }
    );
    
    return res.json({ ok: true });
  } catch (e) {
    console.error("[PUT /api/admin/users/password] Error:", e);
    return res.status(500).json({ message: "Error actualizando la clave" });
  }
});

// Cambiar clave (ADMIN)
app.put("/api/admin/users/:username/password", requireAdmin, express.json(), async (req, res) => {
  const { username } = req.params;
  const { newPassword } = req.body || {};
  if (!newPassword || String(newPassword).length < 4) {
    return res.status(400).json({ message: "La nueva clave debe tener al menos 4 caracteres" });
  }
  const db = await connect();
  const user = await db.collection("users").findOne({ username });
  if (!user) return res.status(404).json({ message: "Usuario no existe" });

  const hash = await bcrypt.hash(String(newPassword), 10);
  await db.collection("users").updateOne({ username }, { $set: { password: hash, updatedAt: new Date() } });
  res.json({ ok: true });
});

const port = process.env.PORT || 4000;
app.listen(port, () => console.log(`API running on https://fares-backend.onrender.com/api`));
