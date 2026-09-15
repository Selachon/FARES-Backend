import { computeCertificateExpiry } from "./certificateExpiry.js";
import { ObjectId } from "mongodb";
import crypto from "node:crypto";
import { connect, getMongoClient } from "./db.js";
import { createError, logger } from "./utils.js";
import {
  STATES,
  OPERATIONS,
  text,
  serialKey,
  validSerial,
  scope,
  canRead,
  isManager,
  assertAdmin,
  cleanItem,
  quality,
  fingerprint,
  observationDate,
  inventoryDate,
  technicalConflicts,
  isColombia,
} from "./inventoryModel.js";

const objectId = (value) => {
  if (!ObjectId.isValid(value))
    throw createError("Identificador inválido", 400);
  return new ObjectId(value);
};
const escaped = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const certProjection = {
  _id: 1,
  numCert: 1,
  serial: 1,
  empresa: 1,
  assignedUsers: 1,
  fechaCargue: 1,
  tipoEquipo: 1,
  tipoInspeccion: 1,
  resultado: 1,
  status: 1,
  tankId: 1,
  "inspeccionCompleta.datosInforme": 1,
};
const serialize = (doc) => {
  const { _id, ...rest } = doc;
  return { id: String(_id), ...rest };
};
const changed = (a, b) => JSON.stringify(a) !== JSON.stringify(b);

export class TankService {
  constructor(options = {}) {
    this.getDb = options.getDb || connect;
    this.getClient = options.getClient || getMongoClient;
    this.ready = null;
  }
  async db() {
    const db = await this.getDb();
    if (!this.ready)
      this.ready = Promise.all([
        db
          .collection("inventory_tanks")
          .createIndex({ serialInterno: 1 }, { unique: true }),
        db
          .collection("inventory_tanks")
          .createIndex({ identityKey: 1 }, { unique: true, sparse: true }),
        db
          .collection("inventory_tanks")
          .createIndex({ requestId: 1 }, { unique: true, sparse: true }),
        db
          .collection("inventory_tanks")
          .createIndex({ empresa: 1, serialNormalized: 1 }),
        db
          .collection("inventory_tanks")
          .createIndex({ empresa: 1, assignedUsers: 1, estado: 1 }),
        db.collection("inventory_tanks").createIndex({ location: "2dsphere" }),
        db
          .collection("inventory_events")
          .createIndex({ tankId: 1, createdAt: -1 }),
        db
          .collection("inventory_reconciliation")
          .createIndex({ certificateId: 1 }, { unique: true }),
        db.collection("certificates").createIndex({ tankId: 1 }),
      ]).catch((e) => {
        this.ready = null;
        throw e;
      });
    await this.ready;
    return db;
  }
  async transaction(fn) {
    const db = await this.db();
    return this.getClient().withSession((session) =>
      session.withTransaction(() => fn(db, session)),
    );
  }
  async event(db, session, tank, type, user, details = {}) {
    await db.collection("inventory_events").insertOne(
      {
        tankId: String(tank._id),
        serialInterno: tank.serialInterno,
        type,
        actor: user.username || "sistema",
        createdAt: new Date(),
        ...details,
      },
      { session },
    );
  }
  async raw(id, user, db, session) {
    db ||= await this.db();
    const tank = await db
      .collection("inventory_tanks")
      .findOne({ _id: objectId(id), ...scope(user) }, { session });
    if (!tank) throw createError("Tanque no disponible o sin acceso", 404);
    return tank;
  }
  enrich(tank) {
    const i = tank.informacionItem || {};
    return {
      ...tank,
      quality: quality(tank),
      ...(isColombia(i.latitud, i.longitud)
        ? {
            location: {
              type: "Point",
              coordinates: [Number(i.longitud), Number(i.latitud)],
            },
          }
        : {}),
    };
  }
  async insert(db, session, data, user, extra = {}) {
    const seq = await db
      .collection("counters")
      .findOneAndUpdate(
        { _id: "inventory_serial" },
        { $inc: { value: 1 } },
        { upsert: true, returnDocument: "after", session },
      );
    const serial = serialKey(data.serialFabricante);
    const tank = this.enrich({
      _id: new ObjectId(),
      serialInterno: `FARES-TQ-${String(seq.value).padStart(6, "0")}`,
      serialFabricante: text(data.serialFabricante),
      serialNormalized: serial,
      aliases: [],
      empresa: data.empresa,
      assignedUsers: data.assignedUsers || [],
      tipoEquipo: data.tipoEquipo || "",
      informacionItem: {
        ...data.informacionItem,
        numeroSerie: text(data.serialFabricante),
      },
      estado: data.estado || "POR_CONFIRMAR",
      estadoOperativo: data.estadoOperativo || "SIN_CONFIRMAR",
      observaciones: text(data.observaciones),
      cover: null,
      photos: [],
      fieldSources: {},
      manualFields: [],
      version: 1,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...extra,
      ...(validSerial(serial)
        ? { identityKey: `${data.empresa}|${serial}` }
        : {}),
    });
    await db.collection("inventory_tanks").insertOne(tank, { session });
    await this.event(db, session, tank, "ALTA", user, {
      reason:
        extra.origin === "certificado"
          ? "Importado desde certificado; existencia por confirmar"
          : "Alta manual",
      effectiveDate: new Date().toISOString().slice(0, 10),
    });
    return tank;
  }
  async validateAssignments(db, empresa, assignedUsers, session) {
    if (!empresa) throw createError("Empresa requerida", 400);
    if (
      !Array.isArray(assignedUsers) ||
      assignedUsers.some((u) => typeof u !== "string")
    )
      throw createError("Usuarios asignados inválidos", 400);
    const names = [...new Set(assignedUsers.map(text))];
    const n = await db
      .collection("users")
      .countDocuments({ empresa, username: { $in: names } }, { session });
    if (n !== names.length)
      throw createError(
        "Los usuarios deben pertenecer a la empresa del tanque",
        400,
      );
    return names;
  }
  async create(data, user) {
    assertAdmin(user);
    const empresa = serialKey(data.empresa),
      item = cleanItem(data.informacionItem);
    const serial = text(data.serialFabricante);
    if (!validSerial(serial) && !data.serialDesconocido)
      throw createError("Indica el serial o marca que es desconocido", 400);
    if (data.tipoEquipo && !["TE", "CT"].includes(data.tipoEquipo))
      throw createError("Tipo de equipo inválido", 400);
    if (
      data.estado &&
      !["EN_INVENTARIO", "POR_CONFIRMAR"].includes(data.estado)
    )
      throw createError("Estado de alta inválido", 400);
    if (data.estadoOperativo && !OPERATIONS.includes(data.estadoOperativo))
      throw createError("Estado operativo inválido", 400);
    if (!/^[\w-]{8,100}$/.test(data.requestId || ""))
      throw createError("Identificador de solicitud requerido", 400);
    try {
      return await this.transaction(async (db, session) => {
        const existing = await db
          .collection("inventory_tanks")
          .findOne({ requestId: data.requestId }, { session });
        if (existing) return serialize(existing);
        if (
          validSerial(serial) &&
          (await db.collection("inventory_tanks").findOne(
            {
              empresa,
              mergedInto: { $exists: false },
              $or: [
                { serialNormalized: serialKey(serial) },
                { aliases: serialKey(serial) },
              ],
            },
            { session },
          ))
        )
          throw createError(
            "El serial corresponde a un tanque existente o a uno de sus seriales anteriores. Busca su ficha.",
            409,
          );
        const assignedUsers = await this.validateAssignments(
          db,
          empresa,
          data.assignedUsers || [],
          session,
        );
        const tank = await this.insert(
          db,
          session,
          {
            ...data,
            empresa,
            serialFabricante: serial,
            assignedUsers,
            informacionItem: item,
          },
          user,
          {
            requestId: data.requestId,
            origin: "manual",
            manualFields: Object.keys(item),
            lastConfirmedAt:
              data.estado === "EN_INVENTARIO" ? new Date() : null,
          },
        );
        return serialize(tank);
      });
    } catch (e) {
      if (e.code === 11000)
        throw createError(
          "Ya existe un tanque con este serial en la empresa. Búscalo antes de añadirlo.",
          409,
        );
      throw e;
    }
  }
  async update(id, data, user) {
    assertAdmin(user);
    return this.transaction(async (db, session) => {
      const t = await this.raw(id, user, db, session);
      if (data.version !== t.version)
        throw createError(
          "La ficha cambió. Actualiza y revisa los datos antes de guardar.",
          409,
        );
      const item = cleanItem({ ...t.informacionItem, ...data.informacionItem });
      const serial =
        data.serialFabricante === undefined
          ? t.serialFabricante
          : text(data.serialFabricante);
      if (!validSerial(serial) && !data.serialDesconocido)
        throw createError("Indica el serial o marca que es desconocido", 400);
      const tipoEquipo = data.tipoEquipo ?? t.tipoEquipo;
      if (tipoEquipo && !["TE", "CT"].includes(tipoEquipo))
        throw createError("Tipo de equipo inválido", 400);
      const estadoOperativo = data.estadoOperativo || t.estadoOperativo;
      if (!OPERATIONS.includes(estadoOperativo))
        throw createError("Estado operativo inválido", 400);
      const assignedUsers = await this.validateAssignments(
        db,
        t.empresa,
        data.assignedUsers ?? t.assignedUsers,
        session,
      );
      if (
        validSerial(serial) &&
        (await db.collection("inventory_tanks").findOne(
          {
            _id: { $ne: t._id },
            empresa: t.empresa,
            mergedInto: { $exists: false },
            $or: [
              { serialNormalized: serialKey(serial) },
              { aliases: serialKey(serial) },
            ],
          },
          { session },
        ))
      )
        throw createError("Otro tanque ya utiliza este serial o alias", 409);
      const fields = Object.keys(item).filter((k) =>
        changed(item[k], t.informacionItem[k]),
      );
      const patch = {
        informacionItem: { ...item, numeroSerie: serial },
        serialFabricante: serial,
        serialNormalized: serialKey(serial),
        tipoEquipo,
        estadoOperativo,
        assignedUsers,
        observaciones: text(data.observaciones ?? t.observaciones),
        updatedAt: new Date(),
        version: t.version + 1,
        manualFields: [...new Set([...t.manualFields, ...fields])],
        aliases: [
          ...new Set([
            ...t.aliases,
            ...(validSerial(t.serialFabricante) &&
            serialKey(serial) !== t.serialNormalized
              ? [t.serialNormalized]
              : []),
          ]),
        ],
        fieldSources: {
          ...t.fieldSources,
          ...Object.fromEntries(
            fields.map((k) => [
              k,
              { type: "manual", actor: user.username, date: new Date() },
            ]),
          ),
        },
      };
      const next = this.enrich({ ...t, ...patch });
      patch.quality = next.quality;
      const unset = {};
      if (isColombia(item.latitud, item.longitud))
        patch.location = next.location;
      else unset.location = "";
      if (validSerial(serial))
        patch.identityKey = `${t.empresa}|${serialKey(serial)}`;
      else unset.identityKey = "";
      try {
        await db.collection("inventory_tanks").updateOne(
          { _id: t._id, version: t.version },
          {
            $set: patch,
            ...(Object.keys(unset).length ? { $unset: unset } : {}),
          },
          { session },
        );
      } catch (e) {
        if (e.code === 11000)
          throw createError(
            "Ya existe otro tanque con ese serial en esta empresa",
            409,
          );
        throw e;
      }
      await this.event(db, session, t, "EDICION", user, {
        reason: text(data.reason) || "Actualización de ficha",
        changes: {
          before: { serial: t.serialFabricante, item: t.informacionItem },
          after: { serial, item: patch.informacionItem },
        },
      });
      return serialize({ ...t, ...patch });
    });
  }
  async movement(id, data, user) {
    assertAdmin(user);
    const transitions = {
      CONFIRMACION: "EN_INVENTARIO",
      BAJA: "BAJA",
      REACTIVACION: "EN_INVENTARIO",
    };
    if (![...Object.keys(transitions), "TRASLADO"].includes(data.type))
      throw createError("Movimiento inválido", 400);
    if (!text(data.reason))
      throw createError("Indica el motivo del movimiento", 400);
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(data.effectiveDate || "") ||
      !Number.isFinite(inventoryDate(data.effectiveDate).getTime()) ||
      data.effectiveDate > new Date().toISOString().slice(0, 10)
    )
      throw createError("Fecha efectiva inválida o futura", 400);
    return this.transaction(async (db, session) => {
      const t = await this.raw(id, user, db, session);
      if (data.version !== t.version)
        throw createError(
          "La ficha cambió. Actualiza antes de registrar el movimiento.",
          409,
        );
      if (
        (data.type === "REACTIVACION") !== (t.estado === "BAJA") &&
        (data.type === "REACTIVACION" || t.estado === "BAJA")
      )
        throw createError(
          "Un tanque dado de baja requiere reactivación explícita",
          409,
        );
      if (data.type === "BAJA" && t.estado === "BAJA")
        throw createError("El tanque ya está dado de baja", 409);
      if (data.type === "CONFIRMACION" && t.estado === "EN_INVENTARIO")
        throw createError("El tanque ya tiene existencia confirmada", 409);
      const patch = { updatedAt: new Date(), version: t.version + 1 };
      if (transitions[data.type]) patch.estado = transitions[data.type];
      if (patch.estado === "EN_INVENTARIO")
        patch.lastConfirmedAt = inventoryDate(data.effectiveDate);
      if (data.type === "BAJA")
        patch.baja = {
          date: data.effectiveDate,
          reason: text(data.reason),
          actor: user.username,
        };
      if (data.type === "TRASLADO") {
        const allowed = [
          "nombreUbicacion",
          "direccion",
          "municipio",
          "departamento",
          "latitud",
          "longitud",
        ];
        const incoming = Object.fromEntries(
          allowed
            .filter((k) => k in (data.location || {}))
            .map((k) => [k, data.location[k]]),
        );
        patch.informacionItem = cleanItem({
          ...t.informacionItem,
          ...incoming,
        });
        patch.manualFields = [...new Set([...t.manualFields, ...allowed])];
        patch.locationDate = inventoryDate(data.effectiveDate);
      }
      const next = this.enrich({ ...t, ...patch });
      patch.quality = next.quality;
      if (
        data.type === "TRASLADO" &&
        isColombia(next.informacionItem.latitud, next.informacionItem.longitud)
      )
        patch.location = next.location;
      await db.collection("inventory_tanks").updateOne(
        { _id: t._id },
        {
          $set: patch,
          ...(data.type === "TRASLADO" && !patch.location
            ? { $unset: { location: "" } }
            : {}),
        },
        { session },
      );
      await this.event(db, session, t, data.type, user, {
        reason: text(data.reason),
        effectiveDate: data.effectiveDate,
        ...(data.type === "TRASLADO"
          ? {
              changes: {
                before: t.informacionItem,
                after: patch.informacionItem,
              },
            }
          : { from: t.estado, to: patch.estado }),
      });
      return serialize({ ...t, ...patch });
    });
  }
  pipeline(user, params = {}) {
    const match = { ...scope(user), mergedInto: { $exists: false } };
    if (isManager(user) && text(params.empresa))
      match.empresa = text(params.empresa);
    if (isManager(user) && text(params.user))
      match.assignedUsers = text(params.user);
    if (STATES.includes(params.estado)) match.estado = params.estado;
    if (["TE", "CT"].includes(params.tipoEquipo))
      match.tipoEquipo = params.tipoEquipo;
    for (const key of [
      "departamento",
      "municipio",
      "fabricante",
      "clasificacion",
      "unidadCapacidad",
    ])
      if (text(params[key]))
        match[`informacionItem.${key}`] = text(params[key]);
    if (OPERATIONS.includes(params.estadoOperativo))
      match.estadoOperativo = params.estadoOperativo;
    const pipe = [
      { $match: match },
      {
        $lookup: {
          from: "certificates",
          let: { id: { $toString: "$_id" } },
          pipeline: [
            { $match: { $expr: { $eq: ["$tankId", "$$id"] }, ...scope(user) } },
            { $project: certProjection },
            {
              $addFields: {
                observationAt: {
                  $convert: {
                    input: {
                      $ifNull: [
                        "$inspeccionCompleta.datosInforme.fechaInspeccion",
                        "$fechaCargue",
                      ],
                    },
                    to: "date",
                    onError: null,
                    onNull: null,
                  },
                },
              },
            },
            {
              $sort: {
                observationAt: -1,
                fechaCargue: -1,
              },
            },
          ],
          as: "certificates",
        },
      },
      { $addFields: { certificateCount: { $size: "$certificates" } } },
    ];
    if (!isManager(user)) {
      pipe.push({
        $set: {
          cover: {
            $cond: [
              {
                $and: [
                  { $ne: [{ $ifNull: ["$cover.certificateId", null] }, null] },
                  {
                    $not: [
                      {
                        $in: [
                          "$cover.certificateId",
                          {
                            $map: {
                              input: "$certificates",
                              as: "c",
                              in: { $toString: "$$c._id" },
                            },
                          },
                        ],
                      },
                    ],
                  },
                ],
              },
              null,
              "$cover",
            ],
          },
        },
      });
      pipe.push({
        $set: {
          quality: {
            $setUnion: [
              { $ifNull: ["$quality", []] },
              { $cond: [{ $eq: ["$cover", null] }, ["foto"], []] },
            ],
          },
        },
      });
    }
    const post = {};
    if (params.q) {
      const terms = text(params.q).split(',').map(value => value.trim()).filter(Boolean).slice(0,20);
      const re = { $regex: terms.map(escaped).join('|'), $options: "i" };
      post.$or = [
        { serialInterno: re },
        { serialFabricante: re },
        { aliases: re },
        { empresa: re },
        { "informacionItem.nombreUbicacion": re },
        { "informacionItem.direccion": re },
        { "certificates.numCert": { $in: terms.filter(value => /^\d+$/.test(value)).map(Number) } },
      ];
    }
    if (params.noCertificates === "1") post.certificateCount = 0;
    if (params.pending === "1") post["quality.0"] = { $exists: true };
    if (params.noLocation === "1") post.quality = "ubicacion";
    if (params.noPhoto === "1") post.cover = null;
    if (text(params.resultado))
      post["certificates.resultado"] = text(params.resultado);
    if (Object.keys(post).length) pipe.push({ $match: post });
    return pipe;
  }
  async list(user, params = {}) {
    const db = await this.db();
    const page = Math.max(1, Number.parseInt(params.page) || 1),
      limit = Math.min(100, Math.max(1, Number.parseInt(params.limit) || 24));
    const sort = [
      "serialInterno",
      "serialFabricante",
      "empresa",
      "updatedAt",
    ].includes(params.sort)
      ? params.sort
      : "serialInterno";
    const [result] = await db
      .collection("inventory_tanks")
      .aggregate([
        ...this.pipeline(user, params),
        {
          $facet: {
            items: [
              { $sort: { [sort]: params.order === "desc" ? -1 : 1, _id: 1 } },
              { $skip: (page - 1) * limit },
              { $limit: limit },
              {
                $project: {
                  fieldSources: 0,
                  manualFields: 0,
                  photos: 0,
                  observaciones: 0,
                },
              },
            ],
            total: [{ $count: "n" }],
          },
        },
      ])
      .toArray();
    return {
      items: result.items.map((t) => this.publicTank(t, user)),
      total: result.total[0]?.n || 0,
      page,
      limit,
    };
  }
  publicTank(t, user) {
    const result = serialize(t);
    delete result.identityKey;
    delete result.requestId;
    if (!isManager(user)) {
      delete result.fieldSources;
      delete result.manualFields;
      delete result.observaciones;
      delete result.baja;
    }
    // A certificate photo is visible only while its source certificate is authorized.
    if (
      !isManager(user) &&
      t.cover?.certificateId &&
      !(t.certificates || []).some(
        (c) => String(c._id) === t.cover.certificateId,
      )
    )
      result.cover = null;
    result.certificates = (t.certificates || []).map((c) => ({
      ...serialize(c),
      inspeccionCompleta: undefined,
      fechaInspeccion: observationDate(c),
      ...computeCertificateExpiry(c),
    }));
    return result;
  }
  async detail(id, user) {
    const db = await this.db();
    const raw = await this.raw(id, user, db);
    if (raw.mergedInto) return { redirectTo: raw.mergedInto };
    const certificates = await db
      .collection("certificates")
      .find(
        { tankId: String(raw._id), ...scope(user) },
        { projection: certProjection },
      )
      .toArray();
    certificates.sort((a, b) => observationDate(b) - observationDate(a));
    return this.publicTank(
      { ...raw, certificates, certificateCount: certificates.length },
      user,
    );
  }
  async summary(user, params = {}) {
    const db = await this.db();
    const [r] = await db
      .collection("inventory_tanks")
      .aggregate([
        ...this.pipeline(user, params),
        {
          $group: {
            _id: null,
            total: { $sum: 1 },
            inInventory: {
              $sum: { $cond: [{ $eq: ["$estado", "EN_INVENTARIO"] }, 1, 0] },
            },
            pending: {
              $sum: { $cond: [{ $eq: ["$estado", "POR_CONFIRMAR"] }, 1, 0] },
            },
            retired: { $sum: { $cond: [{ $eq: ["$estado", "BAJA"] }, 1, 0] } },
            noCertificates: {
              $sum: { $cond: [{ $eq: ["$certificateCount", 0] }, 1, 0] },
            },
            incomplete: {
              $sum: {
                $cond: [
                  { $gt: [{ $size: { $ifNull: ["$quality", []] } }, 0] },
                  1,
                  0,
                ],
              },
            },
            noLocation: {
              $sum: {
                $cond: [
                  { $in: ["ubicacion", { $ifNull: ["$quality", []] }] },
                  1,
                  0,
                ],
              },
            },
          },
        },
      ])
      .toArray();
    return {
      total: 0,
      inInventory: 0,
      pending: 0,
      retired: 0,
      noCertificates: 0,
      incomplete: 0,
      noLocation: 0,
      ...r,
      _id: undefined,
    };
  }
  async options(user) {
    const db = await this.db(),
      m = { ...scope(user), mergedInto: { $exists: false } };
    const fields = [
      "empresa",
      "informacionItem.departamento",
      "informacionItem.municipio",
      "informacionItem.fabricante",
    ];
    const values = await Promise.all(
      fields.map((k) => db.collection("inventory_tanks").distinct(k, m)),
    );
    return Object.fromEntries(
      fields.map((k, i) => [
        k.split(".").at(-1),
        values[i].filter(Boolean).sort(),
      ]),
    );
  }
  async map(user, params = {}) {
    const db = await this.db();
    const rows = await db
      .collection("inventory_tanks")
      .aggregate([
        ...this.pipeline(user, params),
        { $match: { location: { $exists: true } } },
        {
          $project: {
            serialInterno: 1,
            serialFabricante: 1,
            empresa: 1,
            estado: 1,
            location: 1,
            "informacionItem.nombreUbicacion": 1,
          },
        },
      ])
      .toArray();
    const zoom = Math.max(4, Math.min(18, Number(params.zoom) || 5));
    const cell = 360 / (2 ** zoom * 4),
      groups = new Map();
    const bounds = String(params.bounds || "")
      .split(",")
      .map(Number);
    for (const t of rows) {
      const [lng, lat] = t.location.coordinates;
      if (
        bounds.length === 4 &&
        bounds.every(Number.isFinite) &&
        (lng < bounds[0] ||
          lat < bounds[1] ||
          lng > bounds[2] ||
          lat > bounds[3])
      )
        continue;
      const k =
        zoom >= 15
          ? `${lat.toFixed(6)}|${lng.toFixed(6)}`
          : `${Math.floor(lat / cell)}|${Math.floor(lng / cell)}`;
      if (!groups.has(k))
        groups.set(k, { id: k, count: 0, lat: 0, lng: 0, tanks: [] });
      const g = groups.get(k);
      g.count++;
      g.lat += lat;
      g.lng += lng;
      g.tanks.push(serialize(t));
    }
    return {
      located: rows.length,
      groups: [...groups.values()].map((g) => ({
        ...g,
        lat: g.lat / g.count,
        lng: g.lng / g.count,
      })),
    };
  }
  async events(user, params = {}) {
    const db = await this.db();
    const match = { ...scope(user) };
    if (params.tankId) match._id = objectId(params.tankId);
    if (isManager(user) && params.empresa) match.empresa = text(params.empresa);
    const ids = await db
      .collection("inventory_tanks")
      .find(match, { projection: { _id: 1 } })
      .toArray();
    const page = Math.max(1, parseInt(params.page) || 1),
      limit = 20;
    const query = { tankId: { $in: ids.map((t) => String(t._id)) } };
    const [rows, total] = await Promise.all([
      db
        .collection("inventory_events")
        .find(query)
        .sort({ createdAt: -1, _id: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .toArray(),
      db.collection("inventory_events").countDocuments(query),
    ]);
    return {
      items: rows.map((r) =>
        isManager(user)
          ? serialize(r)
          : {
              id: String(r._id),
              tankId: r.tankId,
              serialInterno: r.serialInterno,
              type: r.type,
              createdAt: r.createdAt,
              effectiveDate: r.effectiveDate,
            },
      ),
      page,
      total,
      limit,
    };
  }
  async photos(id, user) {
    const db = await this.db();
    const t = await this.raw(id, user, db);
    const certs = await db
      .collection("certificates")
      .find(
        { tankId: id, ...scope(user) },
        {
          projection: {
            numCert: 1,
            fotos: 1,
            fechaCargue: 1,
            "inspeccionCompleta.datosInforme": 1,
          },
        },
      )
      .toArray();
    return [
      ...(t.photos || []).map((p) => ({ ...p, source: "manual" })),
      ...certs.flatMap((c) =>
        (c.fotos || [])
          .filter((p) => p.category === "area_inspeccion")
          .map((p) => ({
            id: p.id,
            category: p.category,
            certificateId: String(c._id),
            numCert: c.numCert,
            fechaInspeccion: observationDate(c),
            driveFileId: p.driveFileId,
            source: "certificado",
          })),
      ),
    ].map((p) => ({
      ...p,
      url: `/inventory/tanks/${id}/photos/${encodeURIComponent(p.id)}/image${p.certificateId ? `?certificateId=${p.certificateId}` : ""}`,
    }));
  }
  async photoSource(id, photoId, certificateId, user) {
    const db = await this.db();
    const t = await this.raw(id, user, db);
    if (certificateId) {
      const c = await db
        .collection("certificates")
        .findOne({ _id: objectId(certificateId), tankId: id, ...scope(user) });
      const p = c?.fotos?.find(
        (p) => p.id === photoId && p.category === "area_inspeccion",
      );
      if (p) return p;
      if (
        (c || isManager(user)) &&
        t.cover?.photoId === photoId &&
        t.cover?.certificateId === certificateId &&
        t.cover.driveFileId
      )
        return {
          id: photoId,
          category: "area_inspeccion",
          driveFileId: t.cover.driveFileId,
        };
    } else {
      const p = t.photos?.find((p) => p.id === photoId);
      if (p) return p;
    }
    throw createError("Foto no disponible o sin acceso", 404);
  }
  async cover(id, data, user) {
    assertAdmin(user);
    return this.transaction(async (db, session) => {
      const t = await this.raw(id, user, db, session);
      if (data.version !== t.version)
        throw createError(
          "La ficha cambió. Actualiza antes de elegir la portada.",
          409,
        );
      let cover = null;
      if (data.photoId) {
        let p;
        if (data.certificateId) {
          const c = await db
            .collection("certificates")
            .findOne(
              { _id: objectId(data.certificateId), tankId: id },
              { session },
            );
          p = c?.fotos?.find(
            (p) => p.id === data.photoId && p.category === "area_inspeccion",
          );
        } else
          p = t.photos?.find(
            (p) => p.id === data.photoId && p.category === "area_inspeccion",
          );
        if (!p)
          throw createError(
            "La foto debe ser de Área de inspección de este tanque",
            400,
          );
        cover = {
          photoId: p.id,
          certificateId: data.certificateId || null,
          driveFileId: p.driveFileId || null,
          selectedAt: new Date(),
          selectedBy: user.username,
        };
      }
      await db.collection("inventory_tanks").updateOne(
        { _id: t._id },
        {
          $set: {
            cover,
            quality: quality({ ...t, cover }),
            updatedAt: new Date(),
          },
          $inc: { version: 1 },
        },
        { session },
      );
      await this.event(db, session, t, "PORTADA", user, {
        reason: cover ? "Foto de área elegida" : "Portada retirada",
      });
      return { ok: true };
    });
  }
  async addPhoto(id, photo, user, bytes) {
    assertAdmin(user);
    return this.transaction(async (db, session) => {
      const t = await this.raw(id, user, db, session);
      if (photo.storage === "mongodb") {
        if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > 8 * 1024 * 1024)
          throw createError("La foto debe tener entre 1 byte y 8 MB", 400);
        await db.collection("inventory_photo_files").insertOne(
          { _id: photo.id, tankId: id, mimeType: photo.mimeType, bytes, createdAt: new Date() },
          { session },
        );
      }
      await db.collection("inventory_tanks").updateOne(
        { _id: t._id },
        {
          $push: { photos: photo },
          $inc: { version: 1 },
          $set: { updatedAt: new Date() },
        },
        { session },
      );
      await this.event(db, session, t, "FOTO", user, {
        reason: "Foto de área añadida",
      });
      return { ok: true };
    });
  }
  async reconcileCertificate(
    id,
    {
      forceTankId,
      chosenSerial,
      tipoEquipo,
      actor = { username: "sistema", role: "ADMIN" },
    } = {},
  ) {
    return this.transaction(async (db, session) => {
      const c = await db
        .collection("certificates")
        .findOne({ _id: objectId(id) }, { session });
      if (!c) return { skipped: true };
      if (tipoEquipo) {
        if (!["TE", "CT"].includes(tipoEquipo))
          throw createError("Tipo de equipo inválido", 400);
        c.tipoEquipo = tipoEquipo;
        await db
          .collection("certificates")
          .updateOne({ _id: c._id }, { $set: { tipoEquipo } }, { session });
      }
      const hash = fingerprint(c);
      if (!forceTankId && !chosenSerial && c.inventoryFingerprint === hash)
        return { skipped: true };
      const serial = serialKey(chosenSerial || c.serial),
        itemSerial = serialKey(
          c.inspeccionCompleta?.informacionItem?.numeroSerie,
        );
      let reason = "";
      if (!validSerial(serial)) reason = "Serial desconocido o genérico";
      else if (!chosenSerial && itemSerial && serial !== itemSerial)
        reason = "El serial principal difiere del serial del ítem";
      else if (!["TE", "CT"].includes(c.tipoEquipo))
        reason = "Tipo de equipo pendiente de clasificación";
      if ((forceTankId || chosenSerial) && !["TE", "CT"].includes(c.tipoEquipo))
        throw createError("Selecciona el tipo de equipo verificado", 400);
      const candidates = validSerial(serial)
        ? await db
            .collection("inventory_tanks")
            .find(
              {
                empresa: c.empresa,
                mergedInto: { $exists: false },
                $or: [{ serialNormalized: serial }, { aliases: serial }],
              },
              { session },
            )
            .toArray()
        : [];
      let tank = forceTankId
        ? await this.raw(forceTankId, actor, db, session)
        : candidates[0];
      if (forceTankId && tank.empresa !== c.empresa)
        throw createError(
          "El tanque y certificado deben pertenecer a la misma empresa",
          400,
        );
      if (!forceTankId && candidates.length > 1)
        reason = "Hay varios tanques candidatos";
      const conflicts = tank ? technicalConflicts(tank, c) : [];
      if (!forceTankId && conflicts.length)
        reason = `Datos técnicos contradictorios: ${conflicts.join(", ")}`;
      if (reason && !forceTankId && !chosenSerial) {
        await db.collection("inventory_reconciliation").updateOne(
          { certificateId: id },
          {
            $set: {
              certificateId: id,
              numCert: c.numCert,
              empresa: c.empresa,
              serial: c.serial,
              itemSerial,
              reason,
              candidates: candidates.map((t) => ({
                id: String(t._id),
                serialInterno: t.serialInterno,
              })),
              status: "PENDING",
              updatedAt: new Date(),
            },
            $setOnInsert: { createdAt: new Date() },
          },
          { upsert: true, session },
        );
        if (c.tankId) {
          const old = await db
            .collection("inventory_tanks")
            .findOne({ _id: objectId(c.tankId) }, { session });
          if (old)
            await this.event(db, session, old, "CONFLICTO", actor, {
              reason:
                "Certificado retirado de la asociación hasta resolver una discrepancia",
              certificateId: id,
            });
        }
        await db
          .collection("certificates")
          .updateOne(
            { _id: c._id },
            { $set: { inventoryFingerprint: hash }, $unset: { tankId: "" } },
            { session },
          );
        return { pending: true };
      }
      if (!validSerial(serial) && !forceTankId)
        throw createError(
          "Se requiere un serial válido para crear el tanque",
          400,
        );
      if (!tank)
        tank = await this.insert(
          db,
          session,
          {
            empresa: c.empresa,
            serialFabricante: serial,
            assignedUsers: c.assignedUsers,
            tipoEquipo: c.tipoEquipo,
            informacionItem: cleanItem(
              c.inspeccionCompleta?.informacionItem,
              false,
            ),
          },
          actor,
          { origin: "certificado" },
        );
      const date = observationDate(c),
        item = { ...tank.informacionItem },
        sources = { ...tank.fieldSources };
      const incoming = cleanItem(c.inspeccionCompleta?.informacionItem, false);
      for (const [key, value] of Object.entries(incoming)) {
        if (
          key === "numeroSerie" ||
          value == null ||
          value === "" ||
          tank.manualFields.includes(key) ||
          conflicts.includes(key)
        )
          continue;
        if (!sources[key] || date >= new Date(sources[key].date)) {
          item[key] = value;
          sources[key] = { type: "certificado", certificateId: id, date };
        }
      }
      const patch = {
        informacionItem: item,
        fieldSources: sources,
        updatedAt: new Date(),
        tipoEquipo: tank.tipoEquipo || c.tipoEquipo || "",
        locationDate: sources.latitud?.date || tank.locationDate || date,
      };
      const next = this.enrich({ ...tank, ...patch });
      patch.quality = next.quality;
      if (isColombia(item.latitud, item.longitud))
        patch.location = next.location;
      await db.collection("inventory_tanks").updateOne(
        { _id: tank._id },
        {
          $set: patch,
          $inc: { version: 1 },
          ...(!patch.location ? { $unset: { location: "" } } : {}),
        },
        { session },
      );
      await db
        .collection("certificates")
        .updateOne(
          { _id: c._id },
          { $set: { tankId: String(tank._id), inventoryFingerprint: hash } },
          { session },
        );
      if (c.tankId !== String(tank._id))
        await this.event(db, session, tank, "CERTIFICADO", actor, {
          reason: `Certificado ${c.numCert} asociado${tank.estado === "BAJA" ? "; el tanque continúa dado de baja" : ""}`,
          certificateId: id,
        });
      await db.collection("inventory_reconciliation").updateOne(
        { certificateId: id },
        {
          $set: {
            status: "RESOLVED",
            resolvedAt: new Date(),
            resolvedBy: actor.username,
            tankId: String(tank._id),
          },
        },
        { session },
      );
      return { linked: true, tankId: String(tank._id) };
    });
  }
  async reconcileAll(user) {
    assertAdmin(user);
    const db = await this.db();
    const ids = await db
      .collection("certificates")
      .find({}, { projection: { _id: 1 } })
      .sort({ fechaCargue: 1, _id: 1 })
      .toArray();
    const result = { linked: 0, pending: 0, skipped: 0, failed: 0 };
    for (const c of ids) {
      try {
        const r = await this.reconcileCertificate(String(c._id));
        result[r.linked ? "linked" : r.pending ? "pending" : "skipped"]++;
      } catch (e) {
        result.failed++;
        logger.warn("Inventory reconciliation pending retry", {
          certificateId: String(c._id),
          message: e.message,
        });
      }
    }
    return result;
  }
  async conflicts(user) {
    assertAdmin(user);
    const db = await this.db();
    return (
      await db
        .collection("inventory_reconciliation")
        .find({ status: "PENDING" })
        .sort({ updatedAt: -1 })
        .toArray()
    ).map(serialize);
  }
  async resolve(id, data, user) {
    assertAdmin(user);
    if (!text(data.reason))
      throw createError("Indica el motivo de la decisión", 400);
    const db = await this.db();
    const issue = await db
      .collection("inventory_reconciliation")
      .findOne({ _id: objectId(id), status: "PENDING" });
    if (!issue) throw createError("Pendiente no disponible", 404);
    const result = await this.reconcileCertificate(issue.certificateId, {
      forceTankId: data.tankId,
      chosenSerial: data.serial,
      tipoEquipo: data.tipoEquipo,
      actor: user,
    });
    if (result.pending || result.skipped)
      throw createError(
        "Selecciona un tanque o un serial verificado para resolver",
        400,
      );
    await db
      .collection("inventory_reconciliation")
      .updateOne(
        { _id: issue._id },
        { $set: { resolutionReason: text(data.reason) } },
      );
    return result;
  }
}

export const tankService = new TankService();
export async function syncInventoryCertificate(id) {
  try {
    await tankService.reconcileCertificate(String(id));
  } catch (e) {
    logger.warn("Certificate saved; inventory will retry reconciliation", {
      certificateId: String(id),
      message: e.message,
    });
  }
}
