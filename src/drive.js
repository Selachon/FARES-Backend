import { google } from 'googleapis'
import fs from 'fs'

const SCOPES = ['https://www.googleapis.com/auth/drive']

function getAuth() {
  const email = process.env.GOOGLE_CLIENT_EMAIL
  let key = process.env.GOOGLE_PRIVATE_KEY || ''
  key = key.replace(/\\n/g, '\n') // arregla saltos de línea del .env
  if (!email || !key) throw new Error('Faltan GOOGLE_CLIENT_EMAIL / GOOGLE_PRIVATE_KEY')
  return new google.auth.JWT({ email, key, scopes: SCOPES })
}

export async function uploadToDrive({ localPath, fileName, mimeType, appProperties = {}, folderId }) {
  const drive = google.drive({ version: 'v3', auth: getAuth() })

  const { data } = await drive.files.create({
    requestBody: {
      name: fileName,
      parents: folderId ? [folderId] : (process.env.DRIVE_PARENT_FOLDER_ID ? [process.env.DRIVE_PARENT_FOLDER_ID] : undefined),
      mimeType,
      appProperties,
      description: [
        `Usuario(s): ${appProperties.Usuario || ''}`,
        `NumCert: ${appProperties.NumCert || ''}`,
        `Serial: ${appProperties.Serial || ''}`
      ].join(' | ')
    },
    media: { mimeType, body: fs.createReadStream(localPath) },
    fields: 'id, webViewLink, webContentLink'
  })

  // permisos para compartir
  const type = process.env.DRIVE_SHARE_TYPE || 'anyone'
  const role = process.env.DRIVE_SHARE_ROLE || 'reader'
  const perm = { type, role }
  if (type === 'domain' && process.env.DRIVE_DOMAIN) perm.domain = process.env.DRIVE_DOMAIN
  await drive.permissions.create({ fileId: data.id, requestBody: perm })

  return { id: data.id, webViewLink: data.webViewLink, webContentLink: data.webContentLink }
}
