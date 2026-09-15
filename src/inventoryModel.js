import fs from "node:fs";
import crypto from "node:crypto";
import { createError } from "./utils.js";

export const colombia = JSON.parse(
  fs.readFileSync(new URL("./data/colombia.geojson", import.meta.url), "utf8"),
);
export const STATES = ["POR_CONFIRMAR", "EN_INVENTARIO", "BAJA"];
export const OPERATIONS = [
  "SIN_CONFIRMAR",
  "EN_SERVICIO",
  "ALMACENADO",
  "MANTENIMIENTO",
];
export const text = (value) =>
  String(value ?? "")
    .trim()
    .slice(0, 500);
export const serialKey = (value) => text(value).toUpperCase();
export const validSerial = (value) =>
  !!serialKey(value) &&
  !["S/N", "SN", "SIN SERIAL", "SIN SERIE", "N/A", "NA", "0"].includes(
    serialKey(value),
  );
export const isManager = (user) => ["ADMIN", "SUPERVISOR"].includes(user?.role);
export const scope = (user) =>
  isManager(user)
    ? {}
    : { empresa: user.empresa, assignedUsers: user.username };
export const canRead = (doc, user) =>
  isManager(user) ||
  (doc.empresa === user.empresa && doc.assignedUsers?.includes(user.username));
export const assertAdmin = (user) => {
  if (user?.role !== "ADMIN")
    throw createError("Sólo ADMIN puede administrar inventario", 403);
};
export const fingerprint = (c) =>
  crypto
    .createHash("sha256")
    .update(
      JSON.stringify([
        c.serial,
        c.empresa,
        c.tipoEquipo,
        c.inspeccionCompleta?.informacionItem,
        c.inspeccionCompleta?.datosInforme,
        c.assignedUsers,
      ]),
    )
    .digest("hex");
export const inventoryDate = (value) =>
  new Date(
    /^\d{4}-\d{2}-\d{2}$/.test(String(value))
      ? `${value}T00:00:00-05:00`
      : value,
  );
export const observationDate = (c) => {
  const raw =
    c.inspeccionCompleta?.datosInforme?.fechaInspeccion ||
    c.fechaCargue ||
    c.createdAt;
  return Number.isFinite(inventoryDate(raw).getTime())
    ? inventoryDate(raw)
    : new Date(0);
};

function inRing([x, y], ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i],
      [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi)
      inside = !inside;
  }
  return inside;
}
export function isColombia(lat, lng) {
  if (lat === "" || lng === "" || lat == null || lng == null) return false;
  const point = [Number(lng), Number(lat)];
  if (!point.every(Number.isFinite)) return false;
  const polygons =
    colombia.geometry.type === "Polygon"
      ? [colombia.geometry.coordinates]
      : colombia.geometry.coordinates;
  return polygons.some(
    (rings) =>
      inRing(point, rings[0]) &&
      !rings.slice(1).some((ring) => inRing(point, ring)),
  );
}
export const ITEM_FIELDS = [
  "numeroSerie",
  "capacidad",
  "unidadCapacidad",
  "fabricante",
  "anioFabricacion",
  "codigoFabricacion",
  "tipoInstalacion",
  "clasificacion",
  "espesorCuerpo",
  "unidadEspesorCuerpo",
  "espesorCabeza",
  "unidadEspesorCabeza",
  "presionOperacion",
  "unidadPresionOperacion",
  "presionDisenio",
  "unidadPresionDisenio",
  "claseUso",
  "ubicacion",
  "nombreUbicacion",
  "direccion",
  "municipio",
  "departamento",
  "latitud",
  "longitud",
];
const ENUMS = {
  unidadCapacidad: ["GAL", "LITROS", "KG"],
  unidadEspesorCuerpo: ["MM", "IN"],
  unidadEspesorCabeza: ["MM", "IN"],
  unidadPresionOperacion: ["PSI", "KPA"],
  unidadPresionDisenio: ["PSI", "KPA"],
  tipoInstalacion: ["ESTACIONARIO", "CISTERNA"],
  clasificacion: [
    "TIPO 1",
    "TIPO 1 - ENTERRADO",
    "TIPO 2",
    "INTEGRADA",
    "ARTICULADA",
  ],
  claseUso: ["RESIDENCIAL", "INDUSTRIAL", "COMERCIAL"],
  ubicacion: ["RURAL", "URBANO"],
};
export function cleanItem(input = {}, validate = true) {
  const item = {};
  for (const key of ITEM_FIELDS) {
    if (!(key in input)) continue;
    if (["latitud", "longitud"].includes(key)) {
      item[key] =
        input[key] == null || text(input[key]) === ""
          ? null
          : Number(input[key]);
    } else item[key] = text(input[key]);
  }
  if (validate) {
    for (const [key, options] of Object.entries(ENUMS))
      if (item[key] && !options.includes(item[key]))
        throw createError(`Valor inválido: ${key}`, 400);
    for (const key of [
      "capacidad",
      "espesorCuerpo",
      "espesorCabeza",
      "presionOperacion",
      "presionDisenio",
    ]) {
      if (
        item[key] &&
        (!Number.isFinite(Number(item[key].replace(",", "."))) ||
          Number(item[key].replace(",", ".")) <= 0)
      )
        throw createError(`Ingresa un valor positivo para ${key}`, 400);
    }
    if (
      item.anioFabricacion &&
      (!/^\d{4}$/.test(item.anioFabricacion) ||
        Number(item.anioFabricacion) < 1800 ||
        Number(item.anioFabricacion) > new Date().getFullYear())
    )
      throw createError("Año de fabricación inválido", 400);
    if (
      (item.latitud != null || item.longitud != null) &&
      !isColombia(item.latitud, item.longitud)
    )
      throw createError(
        "Selecciona coordenadas válidas dentro de Colombia (incluidas sus islas)",
        400,
      );
  }
  return item;
}
export function quality(tank) {
  const i = tank.informacionItem || {};
  const missing = [];
  if (!validSerial(tank.serialFabricante)) missing.push("identidad");
  if (
    !i.capacidad ||
    !i.unidadCapacidad ||
    !i.fabricante ||
    !i.anioFabricacion ||
    !i.codigoFabricacion ||
    !tank.tipoEquipo ||
    !i.tipoInstalacion ||
    !i.clasificacion ||
    !i.claseUso ||
    !i.ubicacion ||
    !i.espesorCuerpo ||
    !i.espesorCabeza ||
    !i.presionOperacion ||
    !i.presionDisenio
  )
    missing.push("ficha");
  if (!isColombia(i.latitud, i.longitud)) missing.push("ubicacion");
  if (!tank.cover) missing.push("foto");
  return missing;
}
export function technicalConflicts(tank, cert) {
  const a = tank.informacionItem || {},
    b = cert.inspeccionCompleta?.informacionItem || {};
  const fields = ["fabricante", "anioFabricacion"];
  if (a.unidadCapacidad === b.unidadCapacidad) fields.push("capacidad");
  const issues = fields.filter(
    (k) => a[k] && b[k] && serialKey(a[k]) !== serialKey(b[k]),
  );
  if (tank.tipoEquipo && cert.tipoEquipo && tank.tipoEquipo !== cert.tipoEquipo)
    issues.push("tipoEquipo");
  return issues;
}
