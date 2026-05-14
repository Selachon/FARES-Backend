// Certificate document generation.
// Downloads the .docm template from Drive, replaces «Fx» merge-field display
// values directly in the OOXML source (word/document.xml), re-zips the file,
// uploads it to Drive with a forced Google Doc conversion, exports as PDF,
// then deletes the temporary Google Doc.
//
// Why direct XML replacement instead of Docs API replaceAllText:
//   The template uses WPS/VML drawing text boxes (mc:AlternateContent).
//   When imported to Google Docs these become uneditable inline images, so
//   the Docs API cannot reach the text inside them. Editing the source XML
//   before the import is the only reliable approach.
import { google } from "googleapis";
import JSZip from "jszip";
import { PDFDocument } from "pdf-lib";
import { inflateSync, deflateSync } from "zlib";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { config } from "./config.js";
import { logger, retryOperation } from "./utils.js";
import { connect } from "./db.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Signature PNG files (same assets used by the inspection report)
const SIGNATURE_PATHS = {
  AXEL:   path.join(__dirname, "templates", "assets", "firma-axel.png"),
  SERGIO: path.join(__dirname, "templates", "assets", "firma-sergio.png"),
  SOTO:   path.join(__dirname, "templates", "assets", "firma-soto.png"),
  YULIAN: path.join(__dirname, "templates", "assets", "firma-yulian.png"),
  DAVID:  path.join(__dirname, "templates", "assets", "firma-david-rivera.png"),
};

// Page layout constants (template is US Letter 612×792 pt, two copies stacked)
// Horizontal positions derived from the wp:anchor posH values in the .docm XML.
// Vertical positions: each certificate copy occupies ~360 pt; signature line
// sits ~90 pt above the bottom edge of each copy.
const SIG = {
  width:  150,
  height: 66,
  directorX: 146,
  inspectorX: 350,
  bottomCopyY: 155,
};


// Convert an RGB PNG buffer to RGBA, setting every pixel's alpha to the given
// value (0 = fully transparent, 255 = fully opaque). Used to dim the logo watermark.
function pngRgbToRgba(buf, alpha) {
  const crcTable = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    crcTable[i] = c;
  }
  const crc32 = (data) => {
    let crc = 0xffffffff;
    for (const byte of data) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  };
  const makeChunk = (type, data) => {
    const t = Buffer.from(type, "ascii");
    const lenBuf = Buffer.alloc(4); lenBuf.writeUInt32BE(data.length);
    const crcBuf = Buffer.alloc(4); crcBuf.writeUInt32BE(crc32(Buffer.concat([t, data])));
    return Buffer.concat([lenBuf, t, data, crcBuf]);
  };

  const chunks = [];
  let off = 8;
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.slice(off + 4, off + 8).toString("ascii");
    chunks.push({ type, data: buf.slice(off + 8, off + 8 + len) });
    off += 12 + len;
  }

  const ihdr = chunks[0].data;
  const width  = ihdr.readUInt32BE(0);
  const height = ihdr.readUInt32BE(4);
  if (ihdr[8] !== 8 || ihdr[9] !== 2) return buf; // only RGB-8 handled

  const raw = inflateSync(Buffer.concat(chunks.filter(c => c.type === "IDAT").map(c => c.data)));
  const rgbRow = 1 + width * 3;
  const rgbaRow = 1 + width * 4;
  const out = Buffer.alloc(height * rgbaRow);
  for (let y = 0; y < height; y++) {
    out[y * rgbaRow] = raw[y * rgbRow];
    for (let x = 0; x < width; x++) {
      const si = y * rgbRow + 1 + x * 3;
      const di = y * rgbaRow + 1 + x * 4;
      out[di] = raw[si]; out[di + 1] = raw[si + 1]; out[di + 2] = raw[si + 2];
      out[di + 3] = alpha;
    }
  }

  const newIhdr = Buffer.from(ihdr); newIhdr[9] = 6; // RGBA
  const sig = Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]);
  const parts = [sig, makeChunk("IHDR", newIhdr)];
  for (const c of chunks) {
    if (["IHDR","IDAT","tRNS","IEND"].includes(c.type)) continue;
    parts.push(makeChunk(c.type, c.data));
  }
  parts.push(makeChunk("IDAT", deflateSync(out, { level: 6 })));
  parts.push(makeChunk("IEND", Buffer.alloc(0)));
  return Buffer.concat(parts);
}

const DEFAULT_TEMPLATE_ID = "19oR2PLKou81r_-ZnikeyxtD--tGtSCzF";

const MONTHS_ES = [
  "Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio",
  "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre",
];

function formatDateEs(dateStr) {
  if (!dateStr) return "";
  const d = new Date(dateStr.length === 10 ? dateStr + "T12:00:00" : dateStr);
  if (isNaN(d.getTime())) return dateStr;
  return `${d.getDate()} de ${MONTHS_ES[d.getMonth()]} de ${d.getFullYear()}`;
}

function getTipoEquipoLabel(tipoEquipo) {
  return tipoEquipo === "CT" ? "CISTERNA DE TRANSPORTE" : "TANQUE ESTACIONARIO";
}

// Escape characters that are special in XML text content.
function escapeXml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

class CertDocService {
  constructor() {
    this.oauth2 = new google.auth.OAuth2(
      config.google.oauth.clientId,
      config.google.oauth.clientSecret,
    );
    this.oauth2.setCredentials({ refresh_token: config.google.oauth.refreshToken });
    this.drive = google.drive({ version: "v3", auth: this.oauth2 });
  }

  getSignatureKey(name) {
    if (!name) return null;
    const n = String(name).toUpperCase();
    if (n.includes("AXEL"))   return "AXEL";
    if (n.includes("SERGIO")) return "SERGIO";
    if (n.includes("SOTO"))   return "SOTO";
    if (n.includes("YULIAN") || n.includes("JULIÁN") || n.includes("JULIAN")) return "YULIAN";
    if (n.includes("DAVID") || n.includes("EDILSON") || n.includes("RIVERA")) return "DAVID";
    return null;
  }

  async overlaySignatures(pdfBuffer, inspectorName, directorName) {
    const pdfDoc = await PDFDocument.load(pdfBuffer);
    const pages  = pdfDoc.getPages();

    const embedSig = async (key) => {
      if (!key || !SIGNATURE_PATHS[key]) return null;
      try {
        const bytes = fs.readFileSync(SIGNATURE_PATHS[key]);
        return await pdfDoc.embedPng(bytes);
      } catch (err) {
        logger.warn("Could not load signature image", { key, error: err.message });
        return null;
      }
    };

    const directorImg  = await embedSig(this.getSignatureKey(directorName));
    const inspectorImg = await embedSig(this.getSignatureKey(inspectorName));

    // Each exported page is one certificate copy; draw signatures once per page.
    for (const pg of pages) {
      if (directorImg)  pg.drawImage(directorImg,  { x: SIG.directorX,  y: SIG.bottomCopyY, width: SIG.width, height: SIG.height });
      if (inspectorImg) pg.drawImage(inspectorImg, { x: SIG.inspectorX, y: SIG.bottomCopyY, width: SIG.width, height: SIG.height });
    }

    return Buffer.from(await pdfDoc.save());
  }

  async getTemplateId() {
    try {
      const db = await connect();
      const doc = await db.collection("config").findOne({ key: "certTemplateFileId" });
      return doc?.value || DEFAULT_TEMPLATE_ID;
    } catch {
      return DEFAULT_TEMPLATE_ID;
    }
  }

  // Map «Fx» placeholders → actual certificate values.
  buildFieldMap(cert) {
    const insp = cert.inspeccionCompleta || {};
    const info = insp.informacionItem || {};
    const cliente = insp.datosCliente || {};
    const datos = insp.datosInforme || {};
    const today = new Date().toISOString().slice(0, 10);

    return {
      "\u00ABF1\u00BB": String(info.numeroSerie || cert.serial || ""),
      "\u00ABF2\u00BB": getTipoEquipoLabel(cert.tipoEquipo),
      "\u00ABF3\u00BB": String(info.capacidad || ""),
      "\u00ABF4\u00BB": String(cert.tipoInspeccion || ""),
      "\u00ABF6\u00BB": String(insp.inspector || ""),
      "\u00ABF8\u00BB": String(cert.numCert || ""),
      "\u00ABF9\u00BB": formatDateEs(datos.fechaInspeccion),
      "\u00ABF10\u00BB": formatDateEs(today),
      "\u00ABF13\u00BB": String(cliente.cliente || cert.empresa || ""),
      "\u00ABF14\u00BB": String(cliente.nit || ""),
      "\u00ABF15\u00BB": String(cliente.direccion || ""),
      "\u00ABF16\u00BB": String(cliente.telefono || ""),
      "\u00ABF17\u00BB": String(info.direccion || ""),
      "\u00ABF18\u00BB": String(info.ciudad || cliente.ciudad || ""),
      "\u00ABF22\u00BB": String(insp.resolucion || ""),
    };
  }

  async generatePdf(cert) {
    const templateId = await this.getTemplateId();
    const fieldMap = this.buildFieldMap(cert);
    let tempDocId = null;

    try {
      // 1. Download template .docm from Drive as binary buffer.
      logger.info("Downloading cert template from Drive", { templateId });
      const dlRes = await retryOperation(() =>
        this.drive.files.get(
          { fileId: templateId, alt: "media", supportsAllDrives: true },
          { responseType: "arraybuffer" },
        ),
      );
      const templateBuffer = Buffer.from(dlRes.data);

      // 2. Open ZIP, edit word/document.xml.
      const zip = await JSZip.loadAsync(templateBuffer);

      // Dim the background logo watermark (word/media/image10.png) by converting
      // it to RGBA with reduced alpha so it is less visually prominent.
      const logoFile = zip.file("word/media/image10.png");
      if (logoFile) {
        const logoBuf = await logoFile.async("nodebuffer");
        const dimmed = pngRgbToRgba(logoBuf, 50); // 50/255 ≈ 20% opacity
        zip.file("word/media/image10.png", dimmed);
      }

      let docXml = await zip.file("word/document.xml").async("string");

      // Remove MERGEFIELD instruction elements so they don't render as "MERGEFIELD Fx …"
      // when Google Docs imports the file. Using targeted element removal (not full run
      // removal) preserves the surrounding <w:r> and its formatting.
      docXml = docXml.replace(/<w:instrText[^>]*>[\s\S]*?<\/w:instrText>/g, "");
      docXml = docXml.replace(/<w:fldChar[^/]*\/>/g, "");

      // Replace the «Fx» display values with actual certificate data.
      for (const [placeholder, value] of Object.entries(fieldMap)) {
        docXml = docXml.split(placeholder).join(escapeXml(value));
      }

      // Replace clasificación SDT dropdown content with dynamic value.
      // The SDT is identified by its dropDownList containing "TANQUE ESTACIONARIO."
      const clasificacion = escapeXml(String((cert.inspeccionCompleta?.informacionItem?.clasificacion) || ""));
      docXml = docXml.replace(
        /(<w:dropDownList>[\s\S]*?TANQUE ESTACIONARIO[\s\S]*?<\/w:dropDownList>[\s\S]*?<w:sdtContent>[\s\S]*?<w:t>)[^<]*(<\/w:t>)/g,
        `$1${clasificacion}$2`,
      );

      // Add 2 blank lines after the last body-text paragraph (paraId 37A9F138)
      // so there is visual spacing before the signature lines.
      const blankPara = '<w:p><w:pPr><w:pStyle w:val="Prrafodelista"/></w:pPr></w:p>';
      docXml = docXml.replace(
        /(w14:paraId="37A9F138"[\s\S]*?<\/w:p>)/g,
        `$1${blankPara}${blankPara}`,
      );

      // Remove the stray stand-alone '=' paragraph that sits between the two
      // certificate copies in the template (paraId 6A2AC72F).
      docXml = docXml.replace(/<w:p\b[^>]*w14:paraId="6A2AC72F"[^>]*>[\s\S]*?<\/w:p>/g, "");

      // Google Docs ignores w:jc="both" on "List Paragraph" (Prrafodelista) style
      // paragraphs because it maps the style to its own list style that overrides
      // alignment. Remove the pStyle and add the indent explicitly so justification
      // is respected.
      docXml = docXml.replace(
        /(<w:pPr>\s*)<w:pStyle w:val="Prrafodelista"\/>(\s*)(<w:jc w:val="both"\/>)/g,
        '$1<w:ind w:left="720"/>$2$3',
      );

      // Google Docs applies a spurious +36pt (228600 EMU) X offset to column-relative
      // anchors that follow jc=right paragraphs. Target the two affected circles by
      // their anchor IDs (stable identifiers from the template).
      docXml = docXml.replace(
        /(wp14:anchorId="01E258C2"[^>]*>[\s\S]*?relativeFrom="column">\s*<wp:posOffset>)(-?\d+)(<\/wp:posOffset>)/,
        (_, pre, val, suf) => pre + (parseInt(val) - 228600) + suf,
      );
      docXml = docXml.replace(
        /(wp14:anchorId="524B43E0"[^>]*>[\s\S]*?relativeFrom="column">\s*<wp:posOffset>)(-?\d+)(<\/wp:posOffset>)/,
        (_, pre, val, suf) => pre + (parseInt(val) - 228600) + suf,
      );

      zip.file("word/document.xml", docXml);

      // Fix left-border stripe in header2.xml: Google Docs mis-handles
      // wp:positionH relativeFrom="leftMargin" by treating it as "margin",
      // adding the left-margin value (36pt = 457200 EMU) to the posOffset.
      // Subtract that amount to pre-compensate so the stripe lands at x≈0.
      // The same +36pt bug applies to relativeFrom="margin" anchors (the large
      // left background panels that contain the decorative circles).
      const header2File = zip.file("word/header2.xml");
      if (header2File) {
        let h2 = await header2File.async("string");
        h2 = h2.replace(
          /(<wp:positionH\s+relativeFrom="leftMargin">\s*<wp:posOffset>)(-?\d+)(<\/wp:posOffset>)/g,
          (_, pre, val, suf) => pre + (parseInt(val) - 457200) + suf,
        );
        h2 = h2.replace(
          /(<wp:positionH\s+relativeFrom="margin">\s*<wp:posOffset>)(-?\d+)(<\/wp:posOffset>)/g,
          (_, pre, val, suf) => pre + (parseInt(val) - 228600) + suf,
        );
        // Render all header decorative elements behind body content so they
        // don't overlay certificate text in the Google Docs PDF export.
        h2 = h2.replace(/\bbehindDoc="0"/g, 'behindDoc="1"');
        zip.file("word/header2.xml", h2);
      }

      const footer1File = zip.file("word/footer1.xml");
      if (footer1File) {
        let f1 = await footer1File.async("string");
        f1 = f1.replace(/\bbehindDoc="0"/g, 'behindDoc="1"');
        zip.file("word/footer1.xml", f1);
      }

      const filledBuffer = await zip.generateAsync({
        type: "nodebuffer",
        compression: "DEFLATE",
        compressionOptions: { level: 6 },
      });
      logger.info("Cert fields filled in XML", { numCert: cert.numCert });

      // 3. Upload filled .docm to Drive converting to Google Doc (needed for PDF export).
      const { Readable } = await import("stream");
      const uploadRes = await retryOperation(() =>
        this.drive.files.create({
          requestBody: {
            name: `_cert_temp_${cert.numCert}_${Date.now()}`,
            mimeType: "application/vnd.google-apps.document",
          },
          media: {
            mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            body: Readable.from(filledBuffer),
          },
          fields: "id",
          supportsAllDrives: true,
        }),
      );
      tempDocId = uploadRes.data.id;
      logger.info("Filled cert uploaded as Google Doc", { tempDocId, numCert: cert.numCert });

      // 4. Export Google Doc as PDF.
      const exportRes = await this.drive.files.export(
        { fileId: tempDocId, mimeType: "application/pdf" },
        { responseType: "arraybuffer" },
      );
      const rawPdf = Buffer.from(exportRes.data);
      logger.info("Cert PDF exported", { numCert: cert.numCert, bytes: rawPdf.length });

      // Overlay signature images for inspector and director.
      const insp = cert.inspeccionCompleta || {};
      const pdfBuffer = await this.overlaySignatures(rawPdf, insp.inspector, insp.directorTecnico);
      logger.info("Signatures overlaid on cert PDF", { numCert: cert.numCert });

      return pdfBuffer;
    } finally {
      if (tempDocId) {
        this.drive.files
          .delete({ fileId: tempDocId, supportsAllDrives: true })
          .catch((err) =>
            logger.warn("Failed to delete temp cert doc", { tempDocId, error: err.message }),
          );
      }
    }
  }
}

export const certDocService = new CertDocService();
