// Script de inicialización de base de datos (seed)
// Crea usuarios y certificados de ejemplo para desarrollo y demostración
import { MongoClient } from 'mongodb'
import dotenv from 'dotenv'
dotenv.config()

// Obtener URI de conexión desde variables de entorno
const uri = process.env.MONGODB_URI
if (!uri) {
  console.error('❌ Falta MONGODB_URI en server/.env')
  process.exit(1)
}

// Datos de usuarios de ejemplo para seed
const users = [
  { username:'admin', password:'admin123', role:'ADMIN', empresa:'FARES' },
  { username:'surgas', password:'1234', role:'USER', empresa:'SURGAS' },
  { username:'surgas.compras', password:'1234', role:'USER', empresa:'SURGAS' },
  { username:'surgas.logistica', password:'1234', role:'USER', empresa:'SURGAS' },
  { username:'chilco', password:'1234', role:'USER', empresa:'CHILCO' },
]

const now = new Date()
const oneDay = 86400000
const certs = [
  { numCert:1001, serial:'A1B2C3', fechaCargue: now,                      resultado:'CUMPLE',    empresa:'SURGAS', assignedUsers:['surgas','surgas.compras'], links:{ informes:'#', formatos:'#', certificados:'#' } },
  { numCert:1002, serial:'Z9Y8X7', fechaCargue: new Date(now-oneDay*2), resultado:'NO CUMPLE', empresa:'SURGAS', assignedUsers:['surgas.logistica'],       links:{ informes:'#', formatos:'#', certificados:'#' } },
  { numCert:1003, serial:'QW12ER', fechaCargue: new Date(now-oneDay*4), resultado:'CUMPLE',    empresa:'CHILCO', assignedUsers:['chilco'],                  links:{ informes:'#', formatos:'#', certificados:'#' } },
]

// Función principal que ejecuta el proceso de seed
const main = async () => {
  // Conectar a MongoDB con timeout de 8 segundos
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 8000 })
  await client.connect()
  const db = client.db()

  // Referencias a colecciones
  const usersCol = db.collection('users')
  const certsCol = db.collection('certificates')

  // Crear índices para optimizar consultas
  await Promise.all([
    usersCol.createIndex({ username: 1 }, { unique: true }),           // Índice único para username
    usersCol.createIndex({ empresa: 1, role: 1 }),                    // Índice compuesto para empresa y rol
    certsCol.createIndex({ empresa: 1, numCert: 1 }, { unique: true }),// Índice único compuesto para empresa y número
    certsCol.createIndex({ serial: 1 })                               // Índice para serial
  ])

  // Preparar operaciones de upsert para usuarios (actualizar o insertar)
  const userOps = users.map(u => 
    usersCol.updateOne({ username: u.username }, { $set: u }, { upsert: true })
  )
  
  // Preparar operaciones de upsert para certificados
  const certOps = certs.map(c => 
    certsCol.updateOne({ empresa: c.empresa, numCert: c.numCert }, { $set: c }, { upsert: true })
  )

  // Ejecutar todas las operaciones en paralelo
  await Promise.all([...userOps, ...certOps])

  console.log('✅ Seed completado en Atlas')
  await client.close()
}

main().catch(err => {
  console.error('❌ Error en seed:', err)
  process.exit(1)
})
