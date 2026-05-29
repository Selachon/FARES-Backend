/**
 * Tipos y esquemas para el sistema de inspección integrado
 * Basado en el formulario ID-PS-10 de la app móvil
 */

// ==================== ENUMS ====================

export const EVALUACION_ITEM = {
  CUMPLE: 'C',
  NO_CUMPLE: 'NC',
  NO_APLICA: 'NA',
};

export const EVALUACION_ROSCA = {
  CUMPLE: 'C',
  NO_CUMPLE: 'NC',
  NO_ESPECIFICA: 'NE',
  NO_VISIBLE: 'NV',
};

export const TIPO_INSTALACION = {
  ESTACIONARIO: 'ESTACIONARIO',
  CISTERNA: 'CISTERNA',
};

export const CLASIFICACION = {
  TIPO_1: 'TIPO 1',
  TIPO_1_ENTERRADO: 'TIPO 1 - ENTERRADO',
  TIPO_2: 'TIPO 2',
  INTEGRADA: 'INTEGRADA',
  ARTICULADA: 'ARTICULADA',
};

export const CLASE_USO = {
  RESIDENCIAL: 'RESIDENCIAL',
  INDUSTRIAL: 'INDUSTRIAL',
  COMERCIAL: 'COMERCIAL',
};

export const UBICACION = {
  RURAL: 'RURAL',
  URBANO: 'URBANO',
};

export const TIPO_INSPECCION = {
  PARCIAL: 'PARCIAL',
  TOTAL: 'TOTAL',
};

export const RESULTADO_INSPECCION = {
  CUMPLE: 'CUMPLE',
  NO_CUMPLE: 'NO CUMPLE',
  SIN_CONCEPTO: 'SIN CONCEPTO',
};

export const PHOTO_CATEGORIES = [
  'placa_identificacion',
  'area_inspeccion',
  'superficie',
  'soldaduras',
  'roscas_conexiones',
  'hermeticidad',
  'soportes',
  'revision_interna',
  'prueba_hidrostatica',
  'medicion_espesores',
  'proteccion_catodica',
];

export const PHOTO_CATEGORY_LABELS = {
  placa_identificacion: 'Placa de Identificación / Cédula',
  area_inspeccion: 'Área de Inspección',
  superficie: 'Superficie del Ítem',
  soldaduras: 'Soldaduras',
  roscas_conexiones: 'Roscas, Conexiones y Accesorios',
  hermeticidad: 'Hermeticidad',
  soportes: 'Soportes y Sobresanos',
  revision_interna: 'Revisión Interna',
  prueba_hidrostatica: 'Prueba Hidrostática',
  medicion_espesores: 'Medición de Espesores',
  proteccion_catodica: 'Protección Catódica',
};

export const INSPECTORES = [
  'AXEL PARADA - INSPECTOR',
  'JUAN P. SOTO - INSPECTOR',
  'YULIÁN JAVIER LÓPEZ BERMÚDEZ - INSPECTOR',
  'SERGIO ANTONIO CUBILLOS GALVIS - INSPECTOR',
];

export const DIRECTORES_TECNICOS = [
  'AXEL PARADA - DIRECTOR TÉCNICO',
  'JUAN PABLO SOTO - DIRECTOR TÉCNICO',
];

export const RESOLUCIONES = [
  'Resolución 40245 del 7 de Marzo de 2016',
  'Resolución 40304 del 2 de Abril de 2018',
  'Resolución 40490 del 18 de Noviembre de 2022',
];

export const ARTICULOS = ['10.1 y 10.3', '10.1, 10.2 y 10.3', '3.1', '3.1 y 3.2'];

// ==================== LABELS ====================

export const LABELS_ITEMS_EVALUAR = {
  hermeticidad: 'Hermeticidad',
  estadoSoldaduras: 'Estado de Soldaduras',
  abolladuras: 'Abolladuras',
  abombamiento: 'Abombamiento',
  areasCorrosionAislada: 'Áreas de Corrosión Aislada',
  areasCorrosionLinea: 'Áreas de Corrosión en Línea',
  areasCorrosionGeneral: 'Áreas de Corrosión General',
  daniosFuego: 'Daños por Acción de Fuego',
  sobresanosSoportes: 'Sobresanos y Soportes',
  roscasConexionesAccesorios: 'Roscas, conexiones y accesorios',
  estadoTuberias: 'Estado de las tuberías',
  proteccionCatodica: 'Protección Catódica',
  pruebaHidrostatica: 'Prueba Hidrostática',
  revisionInterna: 'Revisión Interna',
  medicionEspesores: 'Medición de Espesores',
};

export const LABELS_EQUIPOS = {
  detectorFugas: 'Detector de Fugas',
  explosimetro: 'Explosímetro',
  medidorProfundidad: 'Medidor de Profundidad',
  medidorAltura: 'Galga',
  pieRey: 'Pie de Rey',
  cintaMetrica: 'Cinta Métrica',
  multimetro: 'Multímetro',
  celdaReferencia: 'Celda de Referencia',
  registrador: 'Registrador',
  termocupla: 'Termocupla',
  transductorPresion: 'Transductor de Presión',
  manometro: 'Manómetro',
  luxometro: 'Luxómetro',
  medidorEspesores: 'Medidor de Espesores',
  bloqueEscalonado: 'Bloque Escalonado',
  videoscopio: 'Videoscopio',
  otro: 'Otro',
};

// ==================== DEFAULTS ====================

export const DEFAULT_ITEMS_EVALUAR = {
  hermeticidad: 'NA',
  estadoSoldaduras: 'NA',
  abolladuras: 'NA',
  abombamiento: 'NA',
  areasCorrosionAislada: 'NA',
  areasCorrosionLinea: 'NA',
  areasCorrosionGeneral: 'NA',
  daniosFuego: 'NA',
  sobresanosSoportes: 'NA',
  roscasConexionesAccesorios: 'NA',
  estadoTuberias: 'NA',
  proteccionCatodica: 'NA',
  pruebaHidrostatica: 'NA',
  revisionInterna: 'NA',
  medicionEspesores: 'NA',
};

export const DEFAULT_EQUIPOS = {
  detectorFugas: '',
  explosimetro: '',
  medidorProfundidad: '',
  medidorAltura: '',
  pieRey: '',
  cintaMetrica: '',
  multimetro: 'N/A',
  celdaReferencia: 'N/A',
  registrador: '',
  termocupla: '',
  transductorPresion: '',
  manometro: '',
  luxometro: '',
  medidorEspesores: '',
  bloqueEscalonado: '',
  videoscopio: '',
  otro: '',
};

export const DEFAULT_REPORTE_EVALUACION = {
  inspeccionVisualSuperficie: '',
  inspeccionVisualSoldaduras: '',
  inspeccionVisualAccesorios: '',
  hermeticidad: '',
  tuberiasConexiones: '',
  pruebaHidrostatica: '',
  revisionInterna: '',
  medicionEspesores: '',
  proteccionCatodica: '',
  observacionesRecomendaciones: '',
};

// ==================== ESTRUCTURAS VACÍAS ====================

export function createEmptyInspeccionCompleta() {
  return {
    datosInforme: {
      numeroInforme: '',
      tipoInspeccion: 'PARCIAL',
      fechaInspeccion: new Date().toISOString(),
      fechaExpedicion: new Date().toISOString(),
      recibidoPor: '',
    },
    datosCliente: {
      cliente: '',
      nit: '',
      direccion: '',
      ciudad: '',
      telefono: '',
    },
    informacionItem: {
      numeroSerie: '',
      capacidad: '',
      unidadCapacidad: 'GAL',
      fabricante: '',
      anioFabricacion: '',
      codigoFabricacion: '',
      tipoInstalacion: 'ESTACIONARIO',
      clasificacion: '',
      espesorCuerpo: '',
      unidadEspesorCuerpo: 'MM',
      espesorCabeza: '',
      unidadEspesorCabeza: 'MM',
      presionOperacion: '',
      unidadPresionOperacion: 'PSI',
      presionDisenio: '',
      unidadPresionDisenio: 'PSI',
      claseUso: '',
      ubicacion: '',
      nombreUbicacion: '',
      direccion: '',
      latitud: null,
      longitud: null,
    },
    itemsEvaluar: { ...DEFAULT_ITEMS_EVALUAR },
    equiposUtilizados: { ...DEFAULT_EQUIPOS },
    reporteEvaluacion: { ...DEFAULT_REPORTE_EVALUACION },
    conexionesAccesorios: {
      accesorios: [],
      verificacionRoscas: [],
    },
    medicionEspesores: {
      cabeza1: [],
      cabeza2: [],
      cuerpo: [],
      espesorMinimoCuerpo: null,
      espesorMinimoCabeza: null,
    },
    pruebaHidrostatica: {
      intervalos: [],
      procedimientoRealizado: '',
      duracionPrueba: '',
      fluidoUtilizado: '',
      equiposUtilizados: {
        registradorDigital: '',
        transductorPresion: '',
        termocupla: '',
        manometro: '',
      },
      revisionHermeticidad: [],
      observaciones: '',
    },
    pruebaHermeticidad: {
      procedimientoRealizado: '',
      gasesUtilizados: '',
      equiposUtilizados: {
        solucionJabonosa: false,
        detectorFugas: '',
      },
      revisionHermeticidad: [],
      observaciones: '',
    },
    inspector: '',
    directorTecnico: '',
    resolucion: '',
    articulos: '',
  };
}

// ==================== VALIDACIÓN ====================

/**
 * Valida un valor de evaluación (C, NC, NA)
 */
export function isValidEvaluacion(value) {
  return ['C', 'NC', 'NA'].includes(value);
}

/**
 * Valida una categoría de foto
 */
export function isValidPhotoCategory(category) {
  return PHOTO_CATEGORIES.includes(category);
}

/**
 * Normaliza la estructura de inspeccionCompleta
 * Asegura que todos los campos existan con valores por defecto
 */
export function normalizeInspeccionCompleta(data) {
  if (!data) return null;

  const empty = createEmptyInspeccionCompleta();
  const rawInformacionItem = data.informacionItem || {};
  const { diagramaItem: _legacyDiagramaItem, ...informacionItemSinDiagrama } = rawInformacionItem;

  return {
    datosInforme: {
      ...empty.datosInforme,
      ...(data.datosInforme || {}),
    },
    datosCliente: {
      ...empty.datosCliente,
      ...(data.datosCliente || {}),
    },
    informacionItem: {
      ...empty.informacionItem,
      ...informacionItemSinDiagrama,
    },
    itemsEvaluar: {
      ...empty.itemsEvaluar,
      ...(data.itemsEvaluar || {}),
    },
    equiposUtilizados: {
      ...empty.equiposUtilizados,
      ...(data.equiposUtilizados || {}),
    },
    reporteEvaluacion: {
      ...empty.reporteEvaluacion,
      ...(data.reporteEvaluacion || {}),
    },
    conexionesAccesorios: {
      accesorios: Array.isArray(data.conexionesAccesorios?.accesorios)
        ? data.conexionesAccesorios.accesorios
        : [],
      verificacionRoscas: Array.isArray(data.conexionesAccesorios?.verificacionRoscas)
        ? data.conexionesAccesorios.verificacionRoscas
        : [],
    },
    medicionEspesores: {
      cabeza1: Array.isArray(data.medicionEspesores?.cabeza1)
        ? data.medicionEspesores.cabeza1
        : [],
      cabeza2: Array.isArray(data.medicionEspesores?.cabeza2)
        ? data.medicionEspesores.cabeza2
        : [],
      cuerpo: Array.isArray(data.medicionEspesores?.cuerpo)
        ? data.medicionEspesores.cuerpo
        : [],
      espesorMinimoCuerpo: data.medicionEspesores?.espesorMinimoCuerpo ?? null,
      espesorMinimoCabeza: data.medicionEspesores?.espesorMinimoCabeza ?? null,
    },
    pruebaHidrostatica: {
      intervalos: Array.isArray(data.pruebaHidrostatica?.intervalos)
        ? data.pruebaHidrostatica.intervalos
        : [],
      procedimientoRealizado: data.pruebaHidrostatica?.procedimientoRealizado || '',
      duracionPrueba: data.pruebaHidrostatica?.duracionPrueba || '',
      fluidoUtilizado: data.pruebaHidrostatica?.fluidoUtilizado || '',
      equiposUtilizados: {
        registradorDigital: data.pruebaHidrostatica?.equiposUtilizados?.registradorDigital || '',
        transductorPresion: data.pruebaHidrostatica?.equiposUtilizados?.transductorPresion || '',
        termocupla: data.pruebaHidrostatica?.equiposUtilizados?.termocupla || '',
        manometro: data.pruebaHidrostatica?.equiposUtilizados?.manometro || '',
      },
      revisionHermeticidad: Array.isArray(data.pruebaHidrostatica?.revisionHermeticidad)
        ? data.pruebaHidrostatica.revisionHermeticidad
        : [],
      observaciones: data.pruebaHidrostatica?.observaciones || '',
    },
    pruebaHermeticidad: {
      procedimientoRealizado: data.pruebaHermeticidad?.procedimientoRealizado || '',
      gasesUtilizados: data.pruebaHermeticidad?.gasesUtilizados || '',
      equiposUtilizados: {
        solucionJabonosa: data.pruebaHermeticidad?.equiposUtilizados?.solucionJabonosa || false,
        detectorFugas: data.pruebaHermeticidad?.equiposUtilizados?.detectorFugas || '',
      },
      revisionHermeticidad: Array.isArray(data.pruebaHermeticidad?.revisionHermeticidad)
        ? data.pruebaHermeticidad.revisionHermeticidad
        : [],
      observaciones: data.pruebaHermeticidad?.observaciones || '',
    },
    inspector: data.inspector || '',
    directorTecnico: data.directorTecnico || '',
    resolucion: data.resolucion || '',
    articulos: data.articulos || '',
  };
}

/**
 * Normaliza una foto para almacenamiento
 */
export function normalizePhoto(photo) {
  if (!photo) return null;

  return {
    id: photo.id || null,
    category: isValidPhotoCategory(photo.category) ? photo.category : 'superficie',
    driveFileId: photo.driveFileId || null,
    driveUrl: photo.driveUrl || null,
    thumbnailUrl: photo.thumbnailUrl || null,
    description: photo.description || '',
    timestamp: photo.timestamp ? new Date(photo.timestamp).toISOString() : new Date().toISOString(),
    includeInPdf: photo.includeInPdf !== false, // Por defecto incluir
  };
}

/**
 * Normaliza un array de fotos
 */
export function normalizePhotos(photos) {
  if (!Array.isArray(photos)) return [];
  return photos.map(normalizePhoto).filter(Boolean);
}
