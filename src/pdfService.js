/**
 * Servicio de generación de PDF para informes de inspección
 * Usa Puppeteer para renderizar HTML a PDF con estilo profesional
 */
import puppeteer from "puppeteer-core";
import chromium from "@sparticuz/chromium";
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

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

class PdfService {
  constructor() {
    this.templatePath = path.join(__dirname, "templates", "inspection-report.ejs");
    this.faresLogoPath = path.join(__dirname, "templates", "assets", "fares-logo.png");
    this.onacLogoPath = path.join(__dirname, "templates", "assets", "onac-logo.png");
    this.combinedLogoPath = path.join(__dirname, "templates", "assets", "fares-onac.webp");
    this.signatureAssetPaths = {
      AXEL: path.join(__dirname, "templates", "assets", "firma-axel.png"),
      SERGIO: path.join(__dirname, "templates", "assets", "firma-sergio.png"),
      SOTO: path.join(__dirname, "templates", "assets", "firma-soto.png"),
      YULIAN: path.join(__dirname, "templates", "assets", "firma-yulian.png"),
      DAVID: path.join(__dirname, "templates", "assets", "firma-david-rivera.png"),
    };
    this.signatureCache = new Map();
    this.browser = null;
    // Embedding photos as base64 can explode HTML size and OOM low-memory hosts.
    // Default to 0 (URL thumbnails only); can be tuned via env when needed.
    this.maxEmbeddedPhotos = Math.max(
      0,
      Number.parseInt(process.env.PDF_MAX_EMBEDDED_PHOTOS || "0", 10) || 0,
    );
  }

  normalizeSelectedSections(selectedSections) {
    const defaults = {
      datosInforme: true,
      datosCliente: true,
      informacionItem: true,
      itemsEvaluar: true,
      equiposUtilizados: true,
      reporteEvaluacion: true,
      conexionesAccesorios: true,
      pruebaHidrostatica: true,
      pruebaHermeticidad: true,
      medicionEspesores: true,
      firmas: true,
      fotos: true,
    };

    if (!selectedSections || typeof selectedSections !== "object") {
      return defaults;
    }

    return {
      ...defaults,
      ...Object.fromEntries(
        Object.entries(selectedSections).map(([key, value]) => [key, value !== false]),
      ),
    };
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

  normalizeSignerName(value) {
    return String(value || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toUpperCase()
      .trim();
  }

  getSignatureKeyForSigner(name) {
    const normalized = this.normalizeSignerName(name);
    if (!normalized) return null;

    if (normalized.includes("AXEL")) return "AXEL";
    if (normalized.includes("SERGIO")) return "SERGIO";
    if (normalized.includes("SOTO")) return "SOTO";
    if (normalized.includes("YULIAN")) return "YULIAN";
    if (
      normalized.includes("DAVID") ||
      normalized.includes("EDILSON") ||
      normalized.includes("RIVERA")
    ) {
      return "DAVID";
    }

    return null;
  }

  getSignatureDataUriForSigner(name) {
    const key = this.getSignatureKeyForSigner(name);
    if (!key) return null;

    if (this.signatureCache.has(key)) {
      return this.signatureCache.get(key);
    }

    const imagePath = this.signatureAssetPaths[key];
    const uri = this.getImageDataUri(imagePath);
    this.signatureCache.set(key, uri);
    return uri;
  }

  async resolvePhotoDataUri(photo) {
    const fileId =
      photo?.driveFileId ||
      driveService.extractFileIdFromLink(photo?.driveUrl) ||
      driveService.extractFileIdFromLink(photo?.thumbnailUrl);

    if (!fileId) return null;

    try {
      return await driveService.getFileDataUri(fileId, "image/jpeg");
    } catch (error) {
      logger.warn("Could not embed photo as data URI for PDF", {
        fileId,
        error: error.message,
      });
      return null;
    }
  }

  async enrichPhotosForPdf(photos, { embedLimit = this.maxEmbeddedPhotos } = {}) {
    if (!Array.isArray(photos) || photos.length === 0) return [];

    const enriched = await Promise.all(
      photos.map(async (photo, index) => {
        const fileId =
          photo?.driveFileId ||
          driveService.extractFileIdFromLink(photo?.driveUrl) ||
          driveService.extractFileIdFromLink(photo?.thumbnailUrl);

        const shouldEmbed = index < Math.max(0, Number(embedLimit) || 0);
        const embeddedSrc = shouldEmbed ? await this.resolvePhotoDataUri(photo) : null;
        const thumbSrc =
          (fileId && driveService.getThumbnailUrl(fileId, "w1200")) ||
          photo?.thumbnailUrl ||
          photo?.driveUrl ||
          null;

        return {
          ...photo,
          pdfSrc: embeddedSrc || thumbSrc,
        };
      }),
    );

    return enriched;
  }

  isTargetClosedError(error) {
    const message = String(error?.message || "");
    return (
      message.includes("Target closed") ||
      message.includes("Session closed") ||
      message.includes("Protocol error")
    );
  }

  async waitForImagesToSettle(page, timeoutMs = 15000) {
    try {
      await page.evaluate(
        async (timeout) => {
          const images = Array.from(document.images || []);
          if (!images.length) return;

          const waitImage = (img) =>
            new Promise((resolve) => {
              if (img.complete) return resolve();

              const done = () => resolve();
              img.addEventListener("load", done, { once: true });
              img.addEventListener("error", done, { once: true });
            });

          await Promise.race([
            Promise.all(images.map((img) => waitImage(img))),
            new Promise((resolve) => setTimeout(resolve, timeout)),
          ]);
        },
        timeoutMs,
      );
    } catch (_) {
      // Best effort: PDF generation can continue even if this wait fails.
    }
  }

  sanitizeFileNamePart(value, fallback = "NA") {
    const normalized = String(value ?? "").trim();
    if (!normalized) return fallback;

    return normalized
      .replace(/[\\/]+/g, "-")
      .replace(/[<>:"|?*\x00-\x1F]/g, "")
      .replace(/\s+/g, " ")
      .slice(0, 80)
      .trim() || fallback;
  }

  /**
   * Obtener instancia de browser (lazy initialization)
   */
  async getBrowser() {
    if (!this.browser || !this.browser.isConnected()) {
      const executablePath =
        process.env.PUPPETEER_EXECUTABLE_PATH || (await chromium.executablePath());

      this.browser = await puppeteer.launch({
        executablePath,
        headless: true,
        defaultViewport: chromium.defaultViewport,
        args: [...chromium.args, "--hide-scrollbars", "--mute-audio"],
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
    const inspection = data?.inspection || {};
    const templateData = {
      ...data,
      PHOTO_CATEGORY_LABELS,
      LABELS_ITEMS_EVALUAR,
      LABELS_EQUIPOS,
      faresLogo: this.getImageDataUri(this.faresLogoPath),
      onacLogo: this.getImageDataUri(this.onacLogoPath),
      combinedLogo: this.getImageDataUri(this.combinedLogoPath, "image/webp"),
      inspectorSignature: this.getSignatureDataUriForSigner(inspection?.inspector),
      directorSignature: this.getSignatureDataUriForSigner(inspection?.directorTecnico),
      formatDate: (dateStr) => {
        if (!dateStr) return "";
        const date = new Date(dateStr);
        return date.toLocaleDateString("es-CO", {
          year: "numeric",
          month: "long",
          day: "numeric",
        });
      },
      formatEvaluacion: (value) => {
        const map = { C: "CUMPLE", NC: "NO CUMPLE", NA: "N/A" };
        return map[value] || value || "";
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
  async generatePdf(certificate, selectedPhotoIds = null, selectedSections = null) {
    try {
      return await this.generatePdfWithOptions(certificate, selectedPhotoIds, selectedSections, {
        embedLimit: this.maxEmbeddedPhotos,
      });
    } catch (error) {
      if (!this.isTargetClosedError(error)) throw error;

      logger.warn("Retrying PDF generation after Chromium target close", {
        certId: certificate.id,
        numCert: certificate.numCert,
      });

      await this.closeBrowser().catch(() => {});

      return this.generatePdfWithOptions(certificate, selectedPhotoIds, selectedSections, {
        embedLimit: 0,
      });
    }
  }

  async generatePdfWithOptions(
    certificate,
    selectedPhotoIds = null,
    selectedSections = null,
    { embedLimit = this.maxEmbeddedPhotos } = {},
  ) {
    const startTime = Date.now();
    logger.info("Starting PDF generation", {
      certId: certificate.id,
      numCert: certificate.numCert,
      photoEmbedLimit: embedLimit,
    });

    try {
      const includeSections = this.normalizeSelectedSections(selectedSections);

      // Filtrar fotos según selección
      let photosToInclude = certificate.fotos || [];
      if (includeSections.fotos === false) {
        photosToInclude = [];
      } else if (selectedPhotoIds && Array.isArray(selectedPhotoIds)) {
        photosToInclude = photosToInclude.filter((p) =>
          selectedPhotoIds.includes(p.id)
        );
      } else {
        // Por defecto incluir solo las marcadas
        photosToInclude = photosToInclude.filter((p) => p.includeInPdf !== false);
      }

      photosToInclude = await this.enrichPhotosForPdf(photosToInclude, { embedLimit });

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
        includeSections,
        photos: photosToInclude,
        photosByCategory,
        generatedAt: new Date().toISOString(),
      });

      // Generar PDF con Puppeteer
      const browser = await this.getBrowser();
      const page = await browser.newPage();

      try {
        await page.setContent(html, {
          waitUntil: "networkidle0",
          timeout: 45000,
        });

        await this.waitForImagesToSettle(page, 15000);

        const pdfBuffer = await page.pdf({
          format: "Letter",
          timeout: 120000,
          scale: 0.95,
          printBackground: true,
          margin: {
            top: "0.5in",
            right: "0.5in",
            bottom: "0.5in",
            left: "0.5in",
          },
        });

        logger.info("PDF generated successfully", {
          certId: certificate.id,
          sizeKb: Math.round(pdfBuffer.length / 1024),
          elapsedMs: Date.now() - startTime,
          photosCount: photosToInclude.length,
        });

        return pdfBuffer;
      } finally {
        await page.close().catch(() => {});
      }
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
  async generateAndUploadPdf(certificate, selectedPhotoIds = null, selectedSections = null) {
    const pdfBuffer = await this.generatePdf(
      certificate,
      selectedPhotoIds,
      selectedSections,
    );

    // Guardar temporalmente
    const tempDir = path.join(__dirname, "..", "uploads");
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    const timestamp = Date.now();
    const safeEmpresa = this.sanitizeFileNamePart(certificate.empresa, "FARES");
    const safeNumCert = this.sanitizeFileNamePart(certificate.numCert, "DRAFT");
    const safeSerial = this.sanitizeFileNamePart(certificate.serial, "SERIAL");
    const pdfFileName = `INF_${safeEmpresa}_${safeNumCert}_${safeSerial}_${timestamp}.pdf`;
    const tempPath = path.join(tempDir, pdfFileName);

    fs.writeFileSync(tempPath, pdfBuffer);

    try {
      // Subir a Drive (priorizar carpeta del certificado)
      let storage = certificate.storage || null;
      if (!storage?.rootFolderId && certificate.numCert) {
        try {
          storage = await driveService.ensureCertificateFolderTree(certificate.numCert);
        } catch (storageErr) {
          logger.warn("Could not ensure certificate folder tree for PDF upload", {
            numCert: certificate.numCert,
            error: storageErr.message,
          });
        }
      }

      const dbFolders = await driveService.getDriveFolders();
      const folderId =
        storage?.rootFolderId || dbFolders.INF || config.google.drive.parentFolderId;

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
        storage,
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
