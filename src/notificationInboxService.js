import { connect } from "./db.js";
import { createError, sanitizeString } from "./utils.js";

class NotificationInboxService {
  constructor() {
    this.usersCollection = "users";
    this.certificatesCollection = "certificates";
  }

  async ensureSeenCursor(username) {
    const safeUsername = sanitizeString(username);
    if (!safeUsername) {
      throw createError("username inválido", 400, "BAD_REQUEST");
    }

    const db = await connect();
    const users = db.collection(this.usersCollection);
    const user = await users.findOne(
      { username: safeUsername },
      { projection: { notificationsSeenAt: 1 } },
    );

    if (!user) {
      throw createError("Usuario no existe", 404, "USER_NOT_FOUND");
    }

    const seenAt = user.notificationsSeenAt;
    if (seenAt instanceof Date && !Number.isNaN(seenAt.getTime())) {
      return seenAt;
    }

    const defaultSeenAt = new Date();
    await users.updateOne(
      { username: safeUsername },
      {
        $set: {
          notificationsSeenAt: defaultSeenAt,
          updatedAt: new Date(),
        },
      },
    );

    return defaultSeenAt;
  }

  async getPendingForUser({ username, empresa }) {
    const safeUsername = sanitizeString(username);
    const safeEmpresa = sanitizeString(empresa).toUpperCase();

    if (!safeUsername || !safeEmpresa) {
      throw createError("Usuario inválido", 400, "BAD_REQUEST");
    }

    const seenAt = await this.ensureSeenCursor(safeUsername);
    const db = await connect();
    const certificates = db.collection(this.certificatesCollection);

    const query = {
      empresa: safeEmpresa,
      assignedUsers: safeUsername,
      createdAt: { $gt: seenAt },
    };

    const pendingCertificates = await certificates
      .find(query, {
        projection: {
          numCert: 1,
          serial: 1,
          empresa: 1,
          createdAt: 1,
        },
      })
      .sort({ createdAt: -1 })
      .toArray();

    const count = pendingCertificates.length;
    const latestCertificate = pendingCertificates[0] || null;
    const pendingNumbers = pendingCertificates
      .map((item) => {
        const value = item?.numCert;
        if (value === null || value === undefined) return "";
        return sanitizeString(String(value));
      })
      .filter(Boolean);

    return {
      count,
      pendingNumbers,
      latestCertificate: latestCertificate || null,
      seenAt,
    };
  }

  async markSeen(username, seenAt = new Date()) {
    const safeUsername = sanitizeString(username);
    if (!safeUsername) {
      throw createError("username inválido", 400, "BAD_REQUEST");
    }

    const safeSeenAt = seenAt instanceof Date ? seenAt : new Date(seenAt);
    if (Number.isNaN(safeSeenAt.getTime())) {
      throw createError("seenAt inválido", 400, "BAD_REQUEST");
    }

    const db = await connect();
    const result = await db.collection(this.usersCollection).updateOne(
      { username: safeUsername },
      {
        $set: {
          notificationsSeenAt: safeSeenAt,
          updatedAt: new Date(),
        },
      },
    );

    if (result.matchedCount === 0) {
      throw createError("Usuario no existe", 404, "USER_NOT_FOUND");
    }

    return safeSeenAt;
  }
}

export const notificationInboxService = new NotificationInboxService();
