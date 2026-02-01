// Servicio para llenar la plantilla Excel con datos de inspección
import ExcelJS from 'exceljs';
import path from 'path';
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
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.readFile(this.templatePath);

      const mainSheet = workbook.getWorksheet('ID-PS-10 Informe de Inspección');
      if (!mainSheet) {
        throw new Error('No se encontró la hoja principal en la plantilla');
      }

      // === DATOS DEL INFORME ===
      this.setCellValue(mainSheet, 'P7', data.datosInforme?.numeroInforme);
      this.setCellValue(mainSheet, 'P9', data.datosInforme?.tipoInspeccion);
      this.setCellValue(mainSheet, 'P10', data.datosInforme?.numeroFormato);
      this.setCellValue(mainSheet, 'P11', this.formatDate(data.datosInforme?.fechaInspeccion));
      this.setCellValue(mainSheet, 'P12', this.formatDate(data.datosInforme?.fechaExpedicion));

      // === DATOS DEL CLIENTE ===
      this.setCellValue(mainSheet, 'H7', data.datosCliente?.cliente);
      this.setCellValue(mainSheet, 'H8', data.datosCliente?.nit);
      this.setCellValue(mainSheet, 'H9', data.datosCliente?.direccion);
      this.setCellValue(mainSheet, 'H10', data.datosCliente?.ciudad);
      this.setCellValue(mainSheet, 'H11', data.datosCliente?.telefono);
      this.setCellValue(mainSheet, 'H12', data.datosCliente?.personaContacto);

      // === INFORMACIÓN DEL ÍTEM ===
      this.setCellValue(mainSheet, 'D15', data.informacionItem?.numeroSerie);
      this.setCellValue(mainSheet, 'D16', data.informacionItem?.capacidad);
      this.setCellValue(mainSheet, 'D17', data.informacionItem?.fabricante);
      this.setCellValue(mainSheet, 'D18', data.informacionItem?.anioFabricacion);
      this.setCellValue(mainSheet, 'D19', data.informacionItem?.codigoFabricacion);
      this.setCellValue(mainSheet, 'D20', data.informacionItem?.tipoInstalacion);
      this.setCellValue(mainSheet, 'D21', data.informacionItem?.clasificacion);
      this.setCellValue(mainSheet, 'D22', data.informacionItem?.espesorCuerpo);
      this.setCellValue(mainSheet, 'D23', data.informacionItem?.espesorCabeza);
      this.setCellValue(mainSheet, 'D24', data.informacionItem?.presionOperacion);
      this.setCellValue(mainSheet, 'D25', data.informacionItem?.presionDisenio);
      this.setCellValue(mainSheet, 'D26', data.informacionItem?.claseUso);
      this.setCellValue(mainSheet, 'D27', data.informacionItem?.ubicacion);
      this.setCellValue(mainSheet, 'D28', data.informacionItem?.direccion);

      // === ÍTEMS A EVALUAR (columnas J, K, L para C, NC, NA) ===
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

        for (const [key, row] of Object.entries(itemsMap)) {
          const value = data.itemsEvaluar[key];
          if (value === 'C') this.setCellValue(mainSheet, `J${row}`, 'X');
          else if (value === 'NC') this.setCellValue(mainSheet, `K${row}`, 'X');
          else if (value === 'NA') this.setCellValue(mainSheet, `L${row}`, 'X');
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
      this.setCellValue(mainSheet, 'N34', data.inspector);
      this.setCellValue(mainSheet, 'N39', data.directorTecnico);
      this.setCellValue(mainSheet, 'G41', data.resolucion);
      this.setCellValue(mainSheet, 'Q41', data.articulos);
      this.setCellValue(mainSheet, 'G43', data.resultado);

      // === OBSERVACIONES (en la celda de observaciones) ===
      const observaciones = data.reporteEvaluacion?.observacionesRecomendaciones || '';
      this.setCellValue(mainSheet, 'H31', observaciones);

      // === REPORTE DE EVALUACIÓN (hoja 2) ===
      const evalSheet = workbook.getWorksheet('Reporte de Evaluación');
      if (evalSheet && data.reporteEvaluacion) {
        this.setCellValue(evalSheet, 'E8', data.reporteEvaluacion.inspeccionVisualSuperficie);
        this.setCellValue(evalSheet, 'E14', data.reporteEvaluacion.inspeccionVisualSoldaduras);
        this.setCellValue(evalSheet, 'E20', data.reporteEvaluacion.inspeccionVisualAccesorios);
        this.setCellValue(evalSheet, 'E26', data.reporteEvaluacion.hermeticidad);
        this.setCellValue(evalSheet, 'E32', data.reporteEvaluacion.tuberiasConexiones);
        this.setCellValue(evalSheet, 'E38', data.reporteEvaluacion.medicionEspesores);
        this.setCellValue(evalSheet, 'E44', data.reporteEvaluacion.pruebaHidrostatica);
        this.setCellValue(evalSheet, 'E50', data.reporteEvaluacion.revisionInterna);
        this.setCellValue(evalSheet, 'E56', data.reporteEvaluacion.proteccionCatodica);
        this.setCellValue(evalSheet, 'E63', data.reporteEvaluacion.observacionesRecomendaciones);
      }

      logger.info('Excel template filled successfully');
      return workbook;
    } catch (error) {
      logger.error('Error filling Excel template', error);
      throw error;
    }
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
