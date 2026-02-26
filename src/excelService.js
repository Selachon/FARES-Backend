// Servicio para llenar la plantilla Excel con datos de inspección
import ExcelJS from 'exceljs';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { logger } from './utils.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

class ExcelService {
  constructor() {
    this.templatePath = path.join(__dirname, '..', 'plantilla-informe.xlsx');
  }

  /**
   * Llena la plantilla Excel con los datos de inspección
   * @param {Object} data - Datos completos de la inspección
   * @returns {Promise<ExcelJS.Workbook>} - Workbook listo para guardar
   */
  async fillTemplate(data) {
    try {
      logger.info('Starting Excel template fill', { 
        serial: data.informacionItem?.numeroSerie,
        cliente: data.datosCliente?.cliente 
      });
      
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.readFile(this.templatePath);

      const mainSheet = workbook.getWorksheet('ID-PS-10 Informe de Inspección');
      if (!mainSheet) {
        throw new Error('No se encontró la hoja principal en la plantilla');
      }

      // === DATOS DEL INFORME ===
      this.setCellValue(mainSheet, 'P7', data.datosInforme?.numeroInforme);
      this.setCellValue(mainSheet, 'P9', data.datosInforme?.tipoInspeccion);
      this.setCellValue(mainSheet, 'P11', this.formatDate(data.datosInforme?.fechaInspeccion));

      // === DATOS DEL CLIENTE ===
      this.setCellValue(mainSheet, 'J7', data.datosCliente?.cliente);
      this.setCellValue(mainSheet, 'J8', data.datosCliente?.nit);
      this.setCellValue(mainSheet, 'J9', data.datosCliente?.direccion);
      this.setCellValue(mainSheet, 'J10', data.datosCliente?.ciudad);
      this.setCellValue(mainSheet, 'J11', data.datosCliente?.telefono);

      // === INFORMACIÓN DEL ÍTEM ===
      this.setCellValueWithDefault(mainSheet, 'D15', data.informacionItem?.numeroSerie, 'NR');
      this.setCellValueWithDefault(mainSheet, 'D16', data.informacionItem?.capacidad, 'NR');
      this.setCellValueWithDefault(mainSheet, 'D17', data.informacionItem?.fabricante, 'NR');
      this.setCellValueWithDefault(mainSheet, 'D18', data.informacionItem?.anioFabricacion, 'NR');
      this.setCellValueWithDefault(mainSheet, 'D19', data.informacionItem?.codigoFabricacion, 'NR');
      this.setCellValueWithDefault(mainSheet, 'D20', data.informacionItem?.tipoInstalacion, 'NR');
      this.setCellValueWithDefault(mainSheet, 'D21', data.informacionItem?.clasificacion, 'NR');
      this.setCellValueWithDefault(mainSheet, 'D22', data.informacionItem?.espesorCuerpo, 'NR');
      this.setCellValueWithDefault(mainSheet, 'D23', data.informacionItem?.espesorCabeza, 'NR');
      this.setCellValueWithDefault(mainSheet, 'D24', data.informacionItem?.presionOperacion, 'NR');
      this.setCellValueWithDefault(mainSheet, 'D25', data.informacionItem?.presionDisenio, 'NR');
      this.setCellValueWithDefault(mainSheet, 'D26', data.informacionItem?.claseUso, 'NR');
      this.setCellValueWithDefault(mainSheet, 'D27', data.informacionItem?.ubicacion, 'NR');
      const direccionInspeccion = data.informacionItem?.nombreUbicacion || data.informacionItem?.direccion;
      this.setCellValueWithDefault(mainSheet, 'D28', direccionInspeccion, 'NR');

      // === ÍTEMS A EVALUAR (columnas J, K, L para C, NC, NA) ===
      // En vez de X, pintamos la celda con el color del encabezado
      const itemFillColors = {
        C: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF92D050' } },  // Verde
        NC: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFF0000' } }, // Rojo
        NA: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFFF00' } }, // Amarillo
      };

      if (data.itemsEvaluar) {
        const itemsMap = {
          hermeticidad: 16,
          estadoSoldaduras: 17,
          abolladuras: 18,
          abombamiento: 19,
          areasCorrosionAislada: 20,
          areasCorrosionLinea: 21,
          areasCorrosionGeneral: 22,
          daniosFuego: 23,
          sobresanosSoportes: 24,
          roscasConexionesAccesorios: 25,
          estadoTuberias: 26,
          proteccionCatodica: 27,
          pruebaHidrostatica: 28,
          revisionInterna: 29,
          medicionEspesores: 30,
        };

        const colMap = { C: 'J', NC: 'K', NA: 'L' };

        for (const [key, row] of Object.entries(itemsMap)) {
          const value = data.itemsEvaluar[key];
          if (value && colMap[value]) {
            const cell = mainSheet.getCell(`${colMap[value]}${row}`);
            cell.fill = itemFillColors[value];
          }
        }
      }

      // === EQUIPOS UTILIZADOS ===
      if (data.equiposUtilizados) {
        this.setCellValue(mainSheet, 'P15', data.equiposUtilizados.detectorFugas);
        this.setCellValue(mainSheet, 'P16', data.equiposUtilizados.explosimetro);
        this.setCellValue(mainSheet, 'P17', data.equiposUtilizados.medidorProfundidad);
        this.setCellValue(mainSheet, 'P18', data.equiposUtilizados.medidorAltura);
        this.setCellValue(mainSheet, 'P19', data.equiposUtilizados.pieRey);
        this.setCellValue(mainSheet, 'P20', data.equiposUtilizados.cintaMetrica);
        this.setCellValue(mainSheet, 'P21', data.equiposUtilizados.multimetro);
        this.setCellValue(mainSheet, 'P22', data.equiposUtilizados.celdaReferencia);
        this.setCellValue(mainSheet, 'P23', data.equiposUtilizados.registrador);
        this.setCellValue(mainSheet, 'P24', data.equiposUtilizados.termocupla);
        this.setCellValue(mainSheet, 'P25', data.equiposUtilizados.transductorPresion);
        this.setCellValue(mainSheet, 'P26', data.equiposUtilizados.manometro);
        this.setCellValue(mainSheet, 'P27', data.equiposUtilizados.luxometro);
        this.setCellValue(mainSheet, 'P28', data.equiposUtilizados.medidorEspesores);
        this.setCellValue(mainSheet, 'P29', data.equiposUtilizados.bloqueEscalonado);
        this.setCellValue(mainSheet, 'P30', data.equiposUtilizados.videoscopio);
        this.setCellValue(mainSheet, 'P31', data.equiposUtilizados.otro);
      }

      // === FIRMAS Y RESULTADO ===
      this.setCellValue(mainSheet, 'N36', data.inspector);
      this.setCellValue(mainSheet, 'N39', data.directorTecnico);
      this.setCellValue(mainSheet, 'G41', data.resolucion);
      this.setCellValue(mainSheet, 'Q41', data.articulos);
      this.setCellValue(mainSheet, 'G43', data.resultado);

      // Aplicar color de fondo al resultado según guía O56:R59
      const resultadoCell = mainSheet.getCell('G43');
      const resultadoNorm = String(data.resultado || '').toUpperCase().trim();
      const resultadoColors = {
        'CUMPLE': { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF92D050' } },
        'NO CUMPLE': { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFF0000' } },
        'SIN CONCEPTO': { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFBFBFBF' } },
      };
      if (resultadoColors[resultadoNorm]) {
        resultadoCell.fill = resultadoColors[resultadoNorm];
      }

      // === OBSERVACIONES (en la celda de observaciones) ===
      const observaciones = data.reporteEvaluacion?.observacionesRecomendaciones || '-';
      this.setCellValueWithDefault(mainSheet, 'H31', observaciones, '-');

      // === REPORTE DE EVALUACIÓN (hoja 2) ===
      const evalSheet = workbook.getWorksheet('Reporte de Evaluación');
      if (evalSheet && data.reporteEvaluacion) {
        this.setCellValueWithDefault(evalSheet, 'E8', data.reporteEvaluacion.inspeccionVisualSuperficie, '-');
        this.setCellValueWithDefault(evalSheet, 'E14', data.reporteEvaluacion.inspeccionVisualSoldaduras, '-');
        this.setCellValueWithDefault(evalSheet, 'E20', data.reporteEvaluacion.inspeccionVisualAccesorios, '-');
        this.setCellValueWithDefault(evalSheet, 'E26', data.reporteEvaluacion.hermeticidad, '-');
        this.setCellValueWithDefault(evalSheet, 'E32', data.reporteEvaluacion.tuberiasConexiones, '-');
        this.setCellValueWithDefault(evalSheet, 'E38', data.reporteEvaluacion.medicionEspesores, '-');
        this.setCellValueWithDefault(evalSheet, 'E44', data.reporteEvaluacion.pruebaHidrostatica, '-');
        this.setCellValueWithDefault(evalSheet, 'E50', data.reporteEvaluacion.revisionInterna, '-');
        this.setCellValueWithDefault(evalSheet, 'E56', data.reporteEvaluacion.proteccionCatodica, '-');
        this.setCellValueWithDefault(evalSheet, 'E63', data.reporteEvaluacion.observacionesRecomendaciones, '-');
      }

      // === REGISTROS FOTOGRAFICOS (hoja 6) ===
      this.insertPhotoRecords(workbook, data.fotos || []);

      logger.info('Excel template filled successfully');
      return workbook;
    } catch (error) {
      logger.error('Error filling Excel template', error);
      throw error;
    }
  }

  insertPhotoRecords(workbook, photos, options = {}) {
    if (!Array.isArray(photos) || photos.length === 0) return;

    const photosSheet = workbook.getWorksheet('Registros Fotográficos');
    if (!photosSheet) return;

    const excludedCategories = new Set(options.excludeCategories || []);

    const slotsByCategory = {
      placa_identificacion: ['B5:D9', 'E5:G9'],
      area_inspeccion: ['H5:J9', 'K5:M9'],
      superficie: [
        'B11:D15', 'E11:G15', 'H11:J15', 'K11:M15',
        'B16:D20', 'E16:G20', 'H16:J20', 'K16:M20',
      ],
      soldaduras: [
        'B22:D26', 'E22:G26', 'H22:J26', 'K22:M26',
        'B27:D31', 'E27:G31', 'H27:J31', 'K27:M31',
      ],
      roscas_conexiones: [
        'B33:D37', 'E33:G37', 'H33:J37', 'K33:M37',
        'B38:D42', 'E38:G42', 'H38:J42', 'K38:M42',
      ],
      hermeticidad: ['B44:D48', 'E44:G48', 'H44:J48', 'K44:M48'],
      soportes: ['B50:D54', 'E50:G54', 'H50:J54', 'K50:M54'],
      revision_interna: ['B56:D60', 'E56:G60', 'H56:J60', 'K56:M60'],
      prueba_hidrostatica: ['B67:D71', 'E67:G71'],
      medicion_espesores: ['H67:J71', 'K67:M71'],
      proteccion_catodica: ['B78:D82', 'E78:G82', 'H78:J82', 'K78:M82'],
    };

    for (const [category, slots] of Object.entries(slotsByCategory)) {
      if (excludedCategories.has(category)) continue;

      const categoryPhotos = photos.filter((photo) => photo?.category === category);
      if (categoryPhotos.length === 0) continue;

      for (let idx = 0; idx < slots.length; idx++) {
        const photo = categoryPhotos[idx];
        if (!photo) break;

        const imageSource = this.resolveImageSource(photo);
        if (!imageSource) continue;

        try {
          const imageId = workbook.addImage(imageSource);
          photosSheet.addImage(imageId, slots[idx]);
        } catch (error) {
          logger.warn('Could not add image to Excel', {
            category,
            slot: slots[idx],
            error: error.message,
          });
        }
      }
    }
  }

  resolveImageSource(photo) {
    const extension = this.getImageExtension(photo);

    if (photo?.uploadedPath && fs.existsSync(photo.uploadedPath)) {
      try {
        const buffer = fs.readFileSync(photo.uploadedPath);
        return { buffer, extension };
      } catch (_err) {
        return null;
      }
    }

    const base64Raw = typeof photo?.base64 === 'string' ? photo.base64.trim() : '';
    if (base64Raw) {
      if (base64Raw.startsWith('data:image/')) {
        return { base64: base64Raw, extension };
      }
      return { base64: `data:image/${extension};base64,${base64Raw}`, extension };
    }

    return null;
  }

  getImageExtension(photo) {
    const mime = String(photo?.uploadedMimeType || '').toLowerCase();
    if (mime === 'image/png') return 'png';

    const uri = String(photo?.uri || '').toLowerCase();
    if (uri.endsWith('.png')) return 'png';

    return 'jpeg';
  }

  async cloneWorkbook(workbook) {
    const cloned = new ExcelJS.Workbook();
    const buffer = await workbook.xlsx.writeBuffer();
    await cloned.xlsx.load(buffer);
    return cloned;
  }

  prepareWorkbookForPdf(workbook, excludedSheetNames = []) {
    const excluded = new Set(excludedSheetNames);

    const sheetsToRemove = workbook.worksheets
      .filter((sheet) => excluded.has(sheet.name))
      .map((sheet) => sheet.id);

    for (const sheetId of sheetsToRemove) {
      workbook.removeWorksheet(sheetId);
    }

    // Hide rows for photo categories that should not appear in PDF
    const photosSheet = workbook.getWorksheet('Registros Fotográficos');
    if (photosSheet) {
      // Revisión interna: rows 55-65
      // Prueba hidrostática: rows 66-76
      // Medición de espesores: rows 66-76 (shares with prueba)
      // Protección catódica: rows 77-87
      // Hide rows 55 to 87 to exclude these sections
      for (let row = 55; row <= 87; row++) {
        const r = photosSheet.getRow(row);
        r.hidden = true;
      }
    }

    for (const sheet of workbook.worksheets) {
      sheet.pageSetup = {
        ...sheet.pageSetup,
        paperSize: 1,
        orientation: 'portrait',
        fitToPage: true,
        fitToWidth: 1,
        fitToHeight: 0,
        horizontalCentered: true,
        margins: {
          top: 0.15,
          bottom: 0.15,
          left: 0.15,
          right: 0.15,
          header: 0,
          footer: 0,
        },
      };
    }

    return workbook;
  }

  /**
   * Helper para establecer valor de celda de forma segura
   */
  setCellValue(sheet, cellAddress, value) {
    if (value !== undefined && value !== null && value !== '') {
      try {
        sheet.getCell(cellAddress).value = value;
      } catch (error) {
        logger.warn(`Could not set cell ${cellAddress}`, { error: error.message });
      }
    }
  }

  setCellValueWithDefault(sheet, cellAddress, value, fallback) {
    const safeValue = value !== undefined && value !== null && value !== '' ? value : fallback;
    try {
      sheet.getCell(cellAddress).value = safeValue;
    } catch (error) {
      logger.warn(`Could not set cell ${cellAddress}`, { error: error.message });
    }
  }

  /**
   * Formatea fecha ISO a formato legible
   */
  formatDate(isoDate) {
    if (!isoDate) return '';
    try {
      const date = new Date(isoDate);
      return date.toLocaleDateString('es-CO', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      });
    } catch {
      return '';
    }
  }

  /**
   * Guarda el workbook a un archivo temporal
   * @param {ExcelJS.Workbook} workbook
   * @returns {Promise<string>} - Path del archivo generado
   */
  async saveWorkbook(workbook, outputPath) {
    await workbook.xlsx.writeFile(outputPath);
    return outputPath;
  }
}

export const excelService = new ExcelService();
