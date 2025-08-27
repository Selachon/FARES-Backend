// server/scripts/seed.js
import { MongoClient } from 'mongodb'
import dotenv from 'dotenv'
dotenv.config()

const uri = process.env.MONGODB_URI
if (!uri) {
  console.error('❌ Falta MONGODB_URI en server/.env')
  process.exit(1)
}

const users = [
  { username:'admin', password:'admin123', role:'ADMIN', empresa:'FARES' },
  { username:'surgas', password:'1234', role:'USER', empresa:'SURGAS' },
  { username:'surgas.compras', password:'1234', role:'USER', empresa:'SURGAS' },
  { username:'surgas.logistica', password:'1234', role:'USER', empresa:'SURGAS' },
  { username:'chilco', password:'1234', role:'USER', empresa:'CHILCO' },
]

const now = new Date()
const certs = [
  { numCert:1001, serial:'A1B2C3', fechaCargue: now,                      resultado:'CUMPLE',    empresa:'SURGAS', assignedUsers:['surgas','surgas.compras'], links:{ informes:'#', formatos:'#', certificados:'#' } },
  { numCert:1002, serial:'Z9Y8X7', fechaCargue: new Date(now-86400000*2), resultado:'NO CUMPLE', empresa:'SURGAS', assignedUsers:['surgas.logistica'],       links:{ informes:'#', formatos:'#', certificados:'#' } },
  { numCert:1003, serial:'QW12ER', fechaCargue: new Date(now-86400000*4), resultado:'CUMPLE',    empresa:'CHILCO', assignedUsers:['chilco'],                  links:{ informes:'#', formatos:'#', certificados:'#' } },
]

const main = async () => {
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 8000 })
  await client.connect()
  const db = client.db()

  const usersCol = db.collection('users')
  const certsCol = db.collection('certificates')

  // Índices (idempotentes)
  await usersCol.createIndex({ username: 1 }, { unique: true })
  await usersCol.createIndex({ empresa: 1, role: 1 })
  await certsCol.createIndex({ empresa: 1, numCert: 1 }, { unique: true })
  await certsCol.createIndex({ serial: 1 })

  // Upserts de usuarios
  for (const u of users) {
    await usersCol.updateOne(
      { username: u.username },
      { $set: u },
      { upsert: true }
    )
  }

  // Upserts de certificados
  for (const c of certs) {
    await certsCol.updateOne(
      { empresa: c.empresa, numCert: c.numCert },
      { $set: c },
      { upsert: true }
    )
  }

  console.log('✅ Seed completado en Atlas')
  await client.close()
}

main().catch(err => {
  console.error('❌ Error en seed:', err)
  process.exit(1)
})
