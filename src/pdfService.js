/**
 * Servicio de generación de PDF para informes de inspección
 * Usa Puppeteer para renderizar HTML a PDF con estilo profesional
 */
import puppeteer from "puppeteer";
import ejs from "ejs";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { logger } from "./utils.js";
import { driveService } from "./driveService.js";
import { config } from "./config.js";
import {
  PHOTO_CATEGORY_LABELS,
  LABELS_ITEMS_EVALUAR,
  LABELS_EQUIPOS,
} from "./inspectionTypes.js";

const EXCLUDED_PDF_PHOTO_CATEGORIES = new Set([
  "hermeticidad",
  "prueba_hidrostatica",
  "medicion_espesores",
]);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

class PdfService {
  constructor() {
    this.templatePath = path.join(__dirname, "templates", "inspection-report.ejs");
    this.faresLogoPath = path.join(__dirname, "templates", "assets", "fares-logo.png");
    this.onacLogoPath = path.join(__dirname, "templates", "assets", "onac-logo.png");
    this.browser = null;
  }

  getImageDataUri(imagePath, mimeType = "image/png") {
    try {
      if (!fs.existsSync(imagePath)) return null;
      const base64 = fs.readFileSync(imagePath).toString("base64");
      return `data:${mimeType};base64,${base64}`;
    } catch (_) {
      return null;
    }
  }

  /**
   * Obtener instancia de browser (lazy initialization)
   */
  async getBrowser() {
    if (!this.browser || !this.browser.isConnected()) {
      this.browser = await puppeteer.launch({
        headless: "new",
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
          "--disable-gpu",
        ],
      });
    }
    return this.browser;
  }

  /**
   * Cerrar browser cuando no se necesite
   */
  async closeBrowser() {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
  }

  /**
   * Genera el HTML del informe de inspección
   */
  async renderTemplate(data) {
    const templateContent = fs.readFileSync(this.templatePath, "utf-8");
    
    // Preparar datos para la plantilla
    const templateData = {
      ...data,
      PHOTO_CATEGORY_LABELS,
      LABELS_ITEMS_EVALUAR,
      LABELS_EQUIPOS,
      faresLogo: this.getImageDataUri(this.faresLogoPath),
      onacLogo: this.getImageDataUri(this.onacLogoPath),
      formatDate: (dateStr) => {
        if (!dateStr) return "—";
        const date = new Date(dateStr);
        return date.toLocaleDateString("es-CO", {
          year: "numeric",
          month: "long",
          day: "numeric",
        });
      },
      formatEvaluacion: (value) => {
        const map = { C: "CUMPLE", NC: "NO CUMPLE", NA: "N/A" };
        return map[value] || value || "—";
      },
    };

    return ejs.render(templateContent, templateData);
  }

  /**
   * Genera un PDF a partir de los datos de inspección
   * @param {Object} certificate - Certificado/borrador con inspeccionCompleta
   * @param {Array} selectedPhotoIds - IDs de fotos a incluir (null = todas con includeInPdf)
   * @returns {Promise<Buffer>} - Buffer del PDF generado
   */
  async generatePdf(certificate, selectedPhotoIds = null) {
    const startTime = Date.now();
    logger.info("Starting PDF generation", {
      certId: certificate.id,
      numCert: certificate.numCert,
    });

    try {
      // Filtrar fotos según selección
      let photosToInclude = certificate.fotos || [];
      if (selectedPhotoIds && Array.isArray(selectedPhotoIds)) {
        photosToInclude = photosToInclude.filter((p) =>
          selectedPhotoIds.includes(p.id)
        );
      } else {
        // Por defecto incluir solo las marcadas
        photosToInclude = photosToInclude.filter((p) => p.includeInPdf !== false);
      }

      photosToInclude = photosToInclude.filter(
        (p) => !EXCLUDED_PDF_PHOTO_CATEGORIES.has(String(p.category || "")),
      );

      // Agrupar fotos por categoría
      const photosByCategory = {};
      for (const photo of photosToInclude) {
        const cat = photo.category || "otros";
        if (!photosByCategory[cat]) {
          photosByCategory[cat] = [];
        }
        photosByCategory[cat].push(photo);
      }

      // Renderizar HTML
      const html = await this.renderTemplate({
        certificate,
        inspection: certificate.inspeccionCompleta || {},
        photos: photosToInclude,
        photosByCategory,
        generatedAt: new Date().toISOString(),
      });

      // Generar PDF con Puppeteer
      const browser = await this.getBrowser();
      const page = await browser.newPage();

      await page.setContent(html, {
        waitUntil: "networkidle0",
        timeout: 30000,
      });

      const pdfBuffer = await page.pdf({
        format: "Letter",
        printBackground: true,
        margin: {
          top: "0.5in",
          right: "0.5in",
          bottom: "0.5in",
          left: "0.5in",
        },
      });

      await page.close();

      logger.info("PDF generated successfully", {
        certId: certificate.id,
        sizeKb: Math.round(pdfBuffer.length / 1024),
        elapsedMs: Date.now() - startTime,
      });

      return pdfBuffer;
    } catch (error) {
      logger.error("PDF generation failed", {
        certId: certificate.id,
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Genera PDF y lo sube a Drive, actualizando el link del informe
   * @param {Object} certificate - Certificado con datos completos
   * @param {Array} selectedPhotoIds - IDs de fotos a incluir
   * @returns {Promise<Object>} - { pdfUrl, pdfFileId }
   */
  async generateAndUploadPdf(certificate, selectedPhotoIds = null) {
    const pdfBuffer = await this.generatePdf(certificate, selectedPhotoIds);

    // Guardar temporalmente
    const tempDir = path.join(__dirname, "..", "uploads");
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    const timestamp = Date.now();
    const pdfFileName = `INF_${certificate.empresa || "FARES"}_${certificate.numCert || "DRAFT"}_${certificate.serial || "SERIAL"}_${timestamp}.pdf`;
    const tempPath = path.join(tempDir, pdfFileName);

    fs.writeFileSync(tempPath, pdfBuffer);

    try {
      // Subir a Drive
      const dbFolders = await driveService.getDriveFolders();
      const folderId = dbFolders.INF || config.google.drive.parentFolderId;

      const uploadResult = await driveService.uploadFile({
        localPath: tempPath,
        fileName: pdfFileName,
        mimeType: "application/pdf",
        appProperties: {
          NumCert: String(certificate.numCert || "DRAFT"),
          Serial: String(certificate.serial || "DRAFT"),
          Type: "INFORME_PDF",
        },
        folderId,
      });

      logger.info("PDF uploaded to Drive", {
        fileId: uploadResult?.id,
        fileName: pdfFileName,
      });

      return {
        pdfUrl: uploadResult?.webViewLink || null,
        pdfFileId: uploadResult?.id || null,
      };
    } finally {
      // Limpiar archivo temporal
      try {
        fs.unlinkSync(tempPath);
      } catch (_) {}
    }
  }
}

export const pdfService = new PdfService();
