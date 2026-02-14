// Servicio de notificaciones en tiempo real via SSE (Server-Sent Events)
// Mantiene conexiones abiertas por usuario y envía eventos cuando se crean certificados
import { buildCertificateCreatedPayload } from "./notificationPayload.js";

/** @type {Map<string, Set<import('express').Response>>} */
const clients = new Map();

/**
 * Registra una conexión SSE para un usuario
 * @param {string} username
 * @param {import('express').Response} res
 */
function addClient(username, res) {
  if (!clients.has(username)) clients.set(username, new Set());
  clients.get(username).add(res);
}

/**
 * Elimina una conexión SSE de un usuario
 * @param {string} username
 * @param {import('express').Response} res
 */
function removeClient(username, res) {
  const set = clients.get(username);
  if (!set) return;
  set.delete(res);
  if (set.size === 0) clients.delete(username);
}

/**
 * Envía un evento SSE a todos los usuarios indicados
 * @param {string[]} usernames
 * @param {object} data  - payload del evento
 */
function notifyUsers(usernames, data) {
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  for (const username of usernames) {
    const set = clients.get(username);
    if (!set) continue;
    for (const res of set) {
      try {
        res.write(payload);
      } catch {
        // conexión rota, se limpiará en 'close'
      }
    }
  }
}

/**
 * Notifica a los usuarios asignados que se creó un certificado nuevo
 * @param {object} cert - certificado recién creado
 */
function notifyCertificateCreated(cert) {
  const users = Array.isArray(cert.assignedUsers) ? cert.assignedUsers : [];
  if (users.length === 0) return;

  notifyUsers(users, buildCertificateCreatedPayload(cert, { source: "realtime" }));
}

export const notificationService = {
  addClient,
  removeClient,
  notifyUsers,
  notifyCertificateCreated,
};
