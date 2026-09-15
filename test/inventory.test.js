import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { MongoClient, ObjectId } from "mongodb";
import { TankService } from "../src/tankService.js";
import { computeCertificateExpiry } from '../src/certificateExpiry.js';
import { observationDate } from '../src/inventoryModel.js';
import { serialKey, isColombia, cleanItem } from "../src/inventoryModel.js";
let repl, client, db, service;
const admin = { role: "ADMIN", username: "admin", empresa: "FARES" },
  supervisor = { role: "SUPERVISOR", username: "supervisor" },
  user = { role: "USER", username: "ana", empresa: "CHILCO" },
  other = { role: "USER", username: "luis", empresa: "OTRA" };
const item = {
  numeroSerie: "M1821393",
  capacidad: "120",
  unidadCapacidad: "GAL",
  fabricante: "Trinity",
  anioFabricacion: "2018",
  codigoFabricacion: "ASME VIII",
  tipoInstalacion: "ESTACIONARIO",
  clasificacion: "TIPO 2",
  claseUso: "COMERCIAL",
  ubicacion: "URBANO",
  espesorCuerpo: "0.175",
  unidadEspesorCuerpo: "IN",
  espesorCabeza: "0.157",
  unidadEspesorCabeza: "IN",
  presionOperacion: "250",
  unidadPresionOperacion: "PSI",
  presionDisenio: "325",
  unidadPresionDisenio: "PSI",
  nombreUbicacion: "Sitio de prueba",
  latitud: 2.9455089681533453,
  longitud: -75.31294964253902,
};
const cert = (num, serial = "M1821393", extra = {}) => ({
  _id: new ObjectId(),
  numCert: num,
  serial,
  empresa: "CHILCO",
  assignedUsers: ["ana"],
  tipoEquipo: "TE",
  tipoInspeccion: "PARCIAL",
  resultado: "CUMPLE",
  fechaCargue: new Date("2026-09-08"),
  inspeccionCompleta: {
    informacionItem: { ...item, numeroSerie: serial },
    datosInforme: { fechaInspeccion: "2026-09-07" },
  },
  fotos: [
    {
      id: `foto-${num}-1`,
      category: "area_inspeccion",
      driveFileId: "drive-1",
    },
    {
      id: `foto-${num}-2`,
      category: "area_inspeccion",
      driveFileId: "drive-2",
    },
    { id: `foto-${num}-3`, category: "superficie", driveFileId: "drive-3" },
  ],
  ...extra,
});
before(async () => {
  repl = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: "wiredTiger" },
  });
  client = new MongoClient(repl.getUri());
  await client.connect();
  db = client.db("inventory_tests");
  service = new TankService({ getDb: async () => db, getClient: () => client });
  await db.collection("users").insertMany([
    { username: "ana", empresa: "CHILCO" },
    { username: "luis", empresa: "OTRA" },
  ]);
  await service.db();
});
after(async () => {
  await client?.close();
  await repl?.stop();
});
test("serial normalization preserves meaningful punctuation and leading zeroes", () => {
  assert.equal(serialKey(" 00-Ab/1 "), "00-AB/1");
  assert.notEqual(serialKey("AB-1"), serialKey("AB1"));
});
test("geography accepts Colombia mainland and islands; rejects empty and foreign coordinates", () => {
  assert.equal(isColombia(item.latitud, item.longitud), true);
  assert.equal(isColombia(12.55, -81.71), true);
  assert.equal(isColombia(13.35, -81.37), true);
  for (const c of [
    [null, null],
    ["", ""],
    [0, 0],
    [40, -74],
    [-33, -70],
  ])
    assert.equal(isColombia(...c), false);
  assert.throws(() => cleanItem({ latitud: 2.9, longitud: null }));
  assert.throws(() => cleanItem({ capacidad: "-1" }));
});
test("historical certificates form one tank and imports remain idempotent", async () => {
  const a = cert(3655),
    b = cert(3656);
  await db.collection("certificates").insertMany([a, b]);
  const first = await service.reconcileCertificate(String(a._id));
  await service.reconcileCertificate(String(b._id));
  assert.deepEqual(await service.reconcileCertificate(String(a._id)), {
    skipped: true,
  });
  const t = await service.detail(first.tankId, admin);
  assert.equal(t.serialFabricante, "M1821393");
  assert.equal(t.certificateCount, 2);
  assert.equal(t.estado, "POR_CONFIRMAR");
  assert.equal(t.cover, null);
  assert.equal(t.informacionItem.espesorCuerpo, "0.175");
  assert.equal((await service.summary(admin)).total, 1);
});
test("manual creation without certificate, idempotency, assignment and later association preserve identity", async () => {
  const input = {
    empresa: "CHILCO",
    serialFabricante: "MAN-001",
    informacionItem: {},
    assignedUsers: ["ana"],
    requestId: "request-manual-001",
    estado: "EN_INVENTARIO",
  };
  const a = await service.create(input, admin),
    again = await service.create(input, admin);
  assert.equal(a.id, again.id);
  assert.equal((await service.detail(a.id, user)).certificateCount, 0);
  assert.equal((await service.summary(user, { noCertificates: "1" })).total, 1);
  const c = cert(4000, "MAN-001");
  await db.collection("certificates").insertOne(c);
  const link = await service.reconcileCertificate(String(c._id));
  assert.equal(link.tankId, a.id);
  const after = await service.detail(a.id, admin);
  assert.equal(after.serialInterno, a.serialInterno);
  assert.equal(after.estado, "EN_INVENTARIO");
  assert.equal(after.certificateCount, 1);
  await assert.rejects(
    () => service.create({ ...input, requestId: "another-request" }, admin),
    (e) => e.statusCode === 409,
  );
});
test("serial discrepancy is queued, never guessed, and supports explicit resolution", async () => {
  const c = cert(4010, "TOP-SERIAL", {
    inspeccionCompleta: {
      informacionItem: { ...item, numeroSerie: "ITEM-SERIAL" },
    },
  });
  await db.collection("certificates").insertOne(c);
  assert.deepEqual(await service.reconcileCertificate(String(c._id)), {
    pending: true,
  });
  assert.equal(
    (await db.collection("certificates").findOne({ _id: c._id })).tankId,
    undefined,
  );
  const issue = (await service.conflicts(admin)).find(
    (i) => i.numCert === 4010,
  );
  const result = await service.resolve(
    issue.id,
    { serial: "ITEM-SERIAL", reason: "Serial verificado en la placa" },
    admin,
  );
  assert.equal(
    (await service.detail(result.tankId, admin)).serialFabricante,
    "ITEM-SERIAL",
  );
});
test("photo picker accepts any area photo, rejects other categories, and survives reorder and new certificates", async () => {
  const t = (await service.list(admin, { q: "3655" })).items[0];
  const c = await db.collection("certificates").findOne({ numCert: 3655 });
  let details = await service.detail(t.id, admin);
  await assert.rejects(
    () =>
      service.cover(
        t.id,
        {
          version: details.version,
          photoId: "foto-3655-3",
          certificateId: String(c._id),
        },
        admin,
      ),
    (e) => e.statusCode === 400,
  );
  await service.cover(
    t.id,
    {
      version: details.version,
      photoId: "foto-3655-2",
      certificateId: String(c._id),
    },
    admin,
  );
  await db
    .collection("certificates")
    .updateOne({ _id: c._id }, { $set: { fotos: [...c.fotos].reverse() } });
  const c2 = cert(4020);
  await db.collection("certificates").insertOne(c2);
  await service.reconcileCertificate(String(c2._id));
  details = await service.detail(t.id, admin);
  assert.equal(details.cover.photoId, "foto-3655-2");
  assert.equal((await service.photos(t.id, user)).length, 6);
  assert.equal(
    (await service.photoSource(t.id, "foto-3655-2", String(c._id), user))
      .driveFileId,
    "drive-2",
  );
});
test("baja requires reason, preserves identity/certificates, and never reactivates from a certificate", async () => {
  let t = (await service.list(admin, { q: "MAN-001" })).items[0];
  await assert.rejects(
    () =>
      service.movement(
        t.id,
        { version: t.version, type: "BAJA", effectiveDate: "2026-09-10" },
        admin,
      ),
    (e) => e.statusCode === 400,
  );
  await service.movement(
    t.id,
    {
      version: t.version,
      type: "BAJA",
      effectiveDate: "2026-09-10",
      reason: "Fuera de servicio",
    },
    admin,
  );
  const c = cert(4030, "MAN-001");
  await db.collection("certificates").insertOne(c);
  await service.reconcileCertificate(String(c._id));
  t = await service.detail(t.id, admin);
  assert.equal(t.estado, "BAJA");
  assert.equal(t.certificateCount, 2);
  await assert.rejects(
    () =>
      service.movement(
        t.id,
        {
          version: t.version,
          type: "CONFIRMACION",
          effectiveDate: "2026-09-10",
          reason: "No debe reactivar",
        },
        admin,
      ),
    (e) => e.statusCode === 409,
  );
  await service.movement(
    t.id,
    {
      version: t.version,
      type: "REACTIVACION",
      effectiveDate: "2026-09-10",
      reason: "Reingreso verificado",
    },
    admin,
  );
  assert.equal((await service.detail(t.id, admin)).estado, "EN_INVENTARIO");
});
test("scopes protect lists, detail, map, photos, events and mutations", async () => {
  const t = (await service.list(admin, { q: "3655" })).items[0];
  // Sharing a company must never grant access to another user's tanks.
  const coworker = { ...user, username: "unassigned-coworker" };
  for (const denied of [other, coworker]) {
    const forgedFilters = { empresa: t.empresa, assignedUsers: user.username };
    assert.equal((await service.list(denied, forgedFilters)).total, 0);
    assert.equal((await service.summary(denied, forgedFilters)).total, 0);
    assert.equal((await service.map(denied, forgedFilters)).groups.length, 0);
    assert.equal((await service.events(denied, { ...forgedFilters, tankId: t.id })).total, 0);
    assert.ok(Object.values(await service.options(denied)).every(values => values.length === 0));
    await assert.rejects(() => service.detail(t.id, denied), e => e.statusCode === 404);
    await assert.rejects(() => service.photos(t.id, denied), e => e.statusCode === 404);
  }
  assert.equal((await service.list(other)).total, 0);
  assert.equal((await service.summary(other)).total, 0);
  assert.equal((await service.map(other)).groups.length, 0);
  assert.equal((await service.events(other)).total, 0);
  await assert.rejects(
    () => service.detail(t.id, other),
    (e) => e.statusCode === 404,
  );
  await assert.rejects(
    () => service.photos(t.id, other),
    (e) => e.statusCode === 404,
  );
  await assert.rejects(
    () => service.create({}, supervisor),
    (e) => e.statusCode === 403,
  );
  await assert.rejects(
    () => service.update(t.id, {}, user),
    (e) => e.statusCode === 403,
  );
  const c = await db.collection("certificates").findOne({ numCert: 3655 });
  await db
    .collection("certificates")
    .updateOne({ _id: c._id }, { $set: { assignedUsers: [] } });
  assert.equal((await service.detail(t.id, user)).cover, null);
  await assert.rejects(
    () => service.photoSource(t.id, "foto-3655-2", String(c._id), user),
    (e) => e.statusCode === 404,
  );
});
test("manual edits survive older inspections and stale writes return conflict", async () => {
  let t = (await service.list(admin, { q: "MAN-001" })).items[0];
  const before = t.version;
  await service.update(
    t.id,
    {
      version: t.version,
      informacionItem: { nombreUbicacion: "Sitio actualizado" },
    },
    admin,
  );
  await assert.rejects(
    () =>
      service.update(t.id, { version: before, observaciones: "stale" }, admin),
    (e) => e.statusCode === 409,
  );
  const c = cert(4040, "MAN-001", {
    fechaCargue: new Date("2020-01-01"),
    inspeccionCompleta: {
      informacionItem: {
        ...item,
        numeroSerie: "MAN-001",
        nombreUbicacion: "Sitio antiguo",
      },
      datosInforme: { fechaInspeccion: "2020-01-01" },
    },
  });
  await db.collection("certificates").insertOne(c);
  await service.reconcileCertificate(String(c._id));
  assert.equal(
    (await service.detail(t.id, admin)).informacionItem.nombreUbicacion,
    "Sitio actualizado",
  );
});
test("concurrent identical candidates create one tank and serial allocation is unique", async () => {
  const c1 = cert(4050, "CONCURRENT"),
    c2 = cert(4051, "CONCURRENT");
  await db.collection("certificates").insertMany([c1, c2]);
  await Promise.all([
    service.reconcileCertificate(String(c1._id)),
    service.reconcileCertificate(String(c2._id)),
  ]);
  const all = await db
    .collection("inventory_tanks")
    .find({ serialNormalized: "CONCURRENT" })
    .toArray();
  assert.equal(all.length, 1);
  assert.equal(
    (await service.detail(String(all[0]._id), admin)).certificateCount,
    2,
  );
  const s = await service.summary(admin);
  assert.equal(s.total, s.inInventory + s.pending + s.retired);
  assert.equal((await service.list(admin, { limit: 1 })).items.length, 1);
  assert.ok((await service.map(admin)).located > 1);
});

test('date-only inspections retain their calendar date in Colombia', () => {
  assert.equal(observationDate({inspeccionCompleta:{datosInforme:{fechaInspeccion:'2026-09-07'}}}).toISOString(), '2026-09-07T05:00:00.000Z');
});
test('inventory uses the shared certificate expiry independently of tank state', () => {
  const c={tipoEquipo:'TE',tipoInspeccion:'PARCIAL',fechaCargue:'2025-01-01T05:00:00Z',status:'ACTIVO'};
  const result=computeCertificateExpiry(c,new Date('2026-09-01'));
  assert.equal(result.computedStatus,'VENCIDO');
  assert.equal(result.dueDate,'2026-01-01T05:00:00.000Z');
  assert.equal(computeCertificateExpiry({...c,status:'RENOVADO'}).computedStatus,'RENOVADO');
});
test('multiple certificate numbers locate the requested distinct tanks', async () => {
  const result=await service.list(admin,{q:'3655,4000'});
  assert.equal(result.total,2);
  assert.deepEqual(result.items.map(t=>t.serialFabricante).sort(),['M1821393','MAN-001']);
});

test('manual photo bytes persist in MongoDB and roll back together with tank metadata', async () => {
  const tank = (await service.list(admin, {q: 'MAN-001'})).items[0];
  const photo = {id: 'persistent-photo', storage: 'mongodb', category: 'area_inspeccion', mimeType: 'image/png'};
  const bytes = Buffer.from([137,80,78,71,13,10,26,10]);
  await service.addPhoto(tank.id, photo, admin, bytes);
  const fresh = new TankService({getDb: async () => db, getClient: () => client});
  assert.equal((await fresh.photoSource(tank.id, photo.id, null, user)).storage, 'mongodb');
  const stored = await db.collection('inventory_photo_files').findOne({_id:photo.id});
  assert.deepEqual(Buffer.from(stored.bytes.buffer), bytes);
  const broken = new TankService({getDb: async () => db, getClient: () => client});
  broken.event = async () => {throw new Error('Simulated failure');};
  await assert.rejects(() => broken.addPhoto(tank.id, {...photo,id:'rollback-photo'}, admin, bytes), /Simulated failure/);
  assert.equal(await db.collection('inventory_photo_files').countDocuments({_id:'rollback-photo'}), 0);
  assert.equal((await fresh.detail(tank.id,admin)).photos.some(p => p.id === 'rollback-photo'), false);
});
