import { MongoClient } from 'mongodb'
import dotenv from 'dotenv'
dotenv.config()

let client, db

// --- MODO MEMORIA (opcional) ---
const inMemory = process.env.USE_MEMORY === '1'
let mem = {
  users: [
    { username:'admin', password:'admin123', role:'ADMIN', empresa:'FARES' },
    { username:'surgas', password:'1234', role:'USER', empresa:'SURGAS' },
    { username:'surgas.compras', password:'1234', role:'USER', empresa:'SURGAS' },
    { username:'surgas.logistica', password:'1234', role:'USER', empresa:'SURGAS' },
    { username:'chilco', password:'1234', role:'USER', empresa:'CHILCO' },
  ],
  certificates: [
    { numCert:1001, serial:'A1B2C3', fechaCargue:new Date(), resultado:'CUMPLE', empresa:'SURGAS', assignedUsers:['surgas','surgas.compras'], links:{ informes:'#', formatos:'#', certificados:'#' } },
    { numCert:1002, serial:'Z9Y8X7', fechaCargue:new Date(Date.now()-86400000*2), resultado:'NO CUMPLE', empresa:'SURGAS', assignedUsers:['surgas.logistica'], links:{ informes:'#', formatos:'#', certificados:'#' } },
    { numCert:1003, serial:'QW12ER', fechaCargue:new Date(Date.now()-86400000*4), resultado:'CUMPLE', empresa:'CHILCO', assignedUsers:['chilco'], links:{ informes:'#', formatos:'#', certificados:'#' } },
  ],
}

function memCollection(name){
  return {
    find(query={}, opts={}) {
      let arr = [...mem[name]]
      return { sort(){ return this }, toArray: async ()=> arr }
    },
    findOne(query){ return Promise.resolve(mem[name].find(u=>u.username===query.username) || null) },
    insertOne(doc){ mem[name].push(doc); return Promise.resolve({ insertedId: doc.numCert || doc.username }) },
    insertMany(docs){ mem[name].push(...docs); return Promise.resolve({ insertedCount: docs.length }) },
    countDocuments(){ return Promise.resolve(mem[name].length) }
  }
}
// --- FIN MODO MEMORIA ---

export async function connect() {
  if (db) return db
  if (inMemory){
    db = {
      collection: (n)=>memCollection(n)
    }
    return db
  }

  const uri = process.env.MONGODB_URI
  client = new MongoClient(uri, { serverSelectionTimeoutMS: 8000 })
  await client.connect()
  db = client.db('fares')
  await seed(db)
  return db
}

async function seed(db){
  const users = db.collection('users')
  if (await users.countDocuments() === 0){
    await users.insertMany([
      { username:'admin', password:'admin123', role:'ADMIN', empresa:'FARES' },
      { username:'surgas', password:'1234', role:'USER', empresa:'SURGAS' },
      { username:'surgas.compras', password:'1234', role:'USER', empresa:'SURGAS' },
      { username:'surgas.logistica', password:'1234', role:'USER', empresa:'SURGAS' },
      { username:'chilco', password:'1234', role:'USER', empresa:'CHILCO' },
    ])
  }
  const certs = db.collection('certificates')
  // if (await certs.countDocuments() === 0){
  //   const now = new Date()
  //   await certs.insertMany([
  //     { numCert:1001, serial:'A1B2C3', fechaCargue: now, resultado:'CUMPLE', empresa:'SURGAS', assignedUsers:['surgas','surgas.compras'], links:{ informes:'#', formatos:'#', certificados:'#' } },
  //     { numCert:1002, serial:'Z9Y8X7', fechaCargue: new Date(now.getTime()-86400000*2), resultado:'NO CUMPLE', empresa:'SURGAS', assignedUsers:['surgas.logistica'], links:{ informes:'#', formatos:'#', certificados:'#' } },
  //     { numCert:1003, serial:'QW12ER', fechaCargue: new Date(now.getTime()-86400000*4), resultado:'CUMPLE', empresa:'CHILCO', assignedUsers:['chilco'], links:{ informes:'#', formatos:'#', certificados:'#' } },
  //   ])
  // }
}
