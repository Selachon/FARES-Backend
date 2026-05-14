// Servicio de gestión de usuarios
// Maneja autenticación, validación, y operaciones CRUD de usuarios
import { connect } from "./db.js";
import bcrypt from "bcryptjs";
import { logger, sanitizeString, parseUserList, createError } from "./utils.js";
import { cacheService } from "./cacheService.js";
import { performanceMonitor } from "./performanceMonitor.js";
import { companyService } from "./companyService.js";

// Hash válido para comparación dummy y mitigación de timing attacks.
const DUMMY_PASSWORD_HASH =
  "$2b$10$an3fzJ3IQLVvXGSRW2.daeQkgB4U2hn5ALQCoXl4Scg7DmKK8VziK";

async function runDummyPasswordCompare(password) {
  try {
    await bcrypt.compare(String(password || ""), DUMMY_PASSWORD_HASH);
  } catch (_) {
    // Nunca bloquear login por fallo del compare dummy.
  }
}

class UserService {
  constructor() {
    this.collectionName = "users";
  }

  // Obtener todos los usuarios de la base de datos (sin contraseñas)
  // Utiliza caché para optimizar rendimiento
  async getAllUsers() {
    try {
      performanceMonitor.trackDbQuery();

      // Usar caché con patrón getOrSet para reducir consultas a BD
      return await cacheService.getOrSet(
        "all_users",
        async () => {
          const db = await connect();
          // Obtener usuarios excluyendo el campo password por seguridad
          const users = await db
            .collection("users")
            .find({}, { projection: { password: 0 } })
            .toArray();
          // Sanitizar y normalizar datos de usuarios
          return users.map((user) => ({
            ...user,
            empresa: sanitizeString(user.empresa),
            username: sanitizeString(user.username),
            role: sanitizeString(user.role),
          }));
        },
        10 * 60 * 1000,  // TTL de 10 minutos para caché
      );
    } catch (error) {
      logger.error("Failed to get all users", error);
      throw createError("Error obteniendo usuarios", 500);
    }
  }

  
  async authenticateUser(username, password) {
    try {
      if (!username || !password) {
        throw createError("Usuario y clave obligatorios", 400);
      }

      const sanitizedUsername = sanitizeString(username);
      const db = await connect();
      
      const user = await db.collection("users").findOne({
        username: sanitizedUsername,
      });

      // Mensaje genérico para prevenir enumeración de usuarios
      const genericError = createError("Credenciales inválidas", 401, "INVALID_CREDENTIALS");

      if (!user) {
        // Ejecutar bcrypt compare con hash dummy para prevenir timing attack
        await runDummyPasswordCompare(password);
        throw genericError;
      }

      const userPassword = String(user.password || "").trim();
      if (!userPassword) {
        logger.warn("Login attempted for user without password", {
          username: user.username,
          empresa: user.empresa,
        });
        // Ejecutar bcrypt compare con hash dummy
        await runDummyPasswordCompare(password);
        throw genericError;
      }

      const isPasswordValid = await this.validatePassword(password, userPassword);

      if (!isPasswordValid) {
        throw genericError;
      }

      return {
        username: user.username,
        role: user.role,
        empresa: user.empresa,
      };
    } catch (error) {
      if (error.statusCode) throw error;

      logger.error("Authentication failed", error);
      throw createError("Error en autenticación", 500);
    }
  }

  
  async validatePassword(inputPassword, storedPassword) {
    if (!storedPassword || typeof storedPassword !== "string") return false;

    // Solo aceptar contraseñas hasheadas con bcrypt
    const looksHashed =
      storedPassword.startsWith("$2a$") || storedPassword.startsWith("$2b$");

    if (!looksHashed) {
      logger.error("Attempted login with non-bcrypt password");
      return false;
    }

    return await bcrypt.compare(inputPassword, storedPassword);
  }

  
  async validateUsersExist(usernames, empresa) {
    try {
      performanceMonitor.trackDbQuery();

      const cacheKey = `user_validation_${usernames.join(",")}_${empresa}`;

      return await cacheService.getOrSet(
        cacheKey,
        async () => {
          const db = await connect();
          const users = await db
            .collection("users")
            .find({ username: { $in: usernames } })
            .project({ username: 1, empresa: 1 })
            .toArray();

          const empresaTarget = sanitizeString(empresa).toUpperCase();

          const hasInvalidUser = users.some((user) => {
            const userEmpresa = sanitizeString(user.empresa).toUpperCase();
            return userEmpresa !== empresaTarget;
          });

          if (users.length !== usernames.length || hasInvalidUser) {
            throw createError(
              "Los usuarios asignados deben existir y pertenecer a la Empresa seleccionada",
              400,
              "INVALID_USER_ASSIGNMENT",
            );
          }

          return true;
        },
        5 * 60 * 1000,
      );
    } catch (error) {
      if (error.statusCode) throw error;

      logger.error("User validation failed", error);
      throw createError("Error validando usuarios", 500);
    }
  }

  
  async updateUserPassword(username, newPassword) {
    try {
      if (!username || !newPassword) {
        throw createError("username y newPassword son obligatorios", 400);
      }

      if (newPassword.length < 8) {
        throw createError(
          "La nueva clave debe tener al menos 8 caracteres",
          400,
        );
      }

      performanceMonitor.trackDbQuery();

      const sanitizedUsername = sanitizeString(username);
      const db = await connect();
      
      const [user, hash] = await Promise.all([
        db.collection("users").findOne({ username: sanitizedUsername }),
        bcrypt.hash(newPassword, 10)
      ]);

      if (!user) {
        throw createError("Usuario no existe", 404);
      }

      const result = await db
        .collection("users")
        .updateOne(
          { username: sanitizedUsername },
          { $set: { password: hash, updatedAt: new Date() } },
        );
      
      if (result.modifiedCount === 0) {
        throw createError("No se pudo actualizar la clave", 500);
      }
      
      cacheService.clear("all_users");
      logger.info("User password updated", { username });
      return { ok: true };
    } catch (error) {
      if (error.statusCode) throw error;

      logger.error("Password update failed", error);
      throw createError("Error actualizando la clave", 500);
    }
  }

  
  async adminUpdateUserPassword(username, newPassword) {
    try {
      if (!username || !newPassword) {
        throw createError("username y newPassword son obligatorios", 400);
      }

      if (typeof newPassword !== "string" || newPassword.length < 8) {
        throw createError("La contraseña debe tener al menos 8 caracteres", 400);
      }

      const sanitizedUsername = sanitizeString(username);
      const db = await connect();
      
      const [user, hash] = await Promise.all([
        db.collection("users").findOne({ username: sanitizedUsername }),
        bcrypt.hash(newPassword, 10)
      ]);

      if (!user) {
        throw createError("Usuario no existe", 404);
      }

      const result = await db
        .collection("users")
        .updateOne(
          { username: sanitizedUsername },
          { $set: { password: hash, updatedAt: new Date() } },
        );

      if (result.modifiedCount === 0) {
        throw createError("No se pudo actualizar la clave", 500);
      }

      logger.info("Admin updated user password", { username });
      return { ok: true };
    } catch (error) {
      if (error.statusCode) throw error;

      logger.error("Admin password update failed", error);
      throw createError("Error actualizando la clave", 500);
    }
  }

  async createUser({ username, password, role, empresa }) {
    try {
      if (!username || !password || !role || !empresa) {
        throw createError(
          "username, password, role y empresa son obligatorios",
          400,
        );
      }

      if (typeof password !== "string" || password.length < 8) {
        throw createError("La contraseña debe tener al menos 8 caracteres", 400);
      }

      const sanitizedUsername = sanitizeString(username);
      const sanitizedRole = sanitizeString(role).toUpperCase();
      const sanitizedEmpresa = sanitizeString(empresa).toUpperCase();

      if (!sanitizedUsername || !sanitizedRole || !sanitizedEmpresa) {
        throw createError("Campos inválidos", 400);
      }

      const allowedRoles = ["ADMIN", "USER", "SUPERVISOR"];
      if (!allowedRoles.includes(sanitizedRole)) {
        throw createError("role inválido", 400);
      }

      performanceMonitor.trackDbQuery();

      const db = await connect();
      const existing = await db
        .collection("users")
        .findOne({ username: sanitizedUsername });

      if (existing) {
        throw createError("El usuario ya existe", 409, "USER_EXISTS");
      }

      const hash = await bcrypt.hash(password, 10);

      const document = {
        username: sanitizedUsername,
        password: hash,
        role: sanitizedRole,
        empresa: sanitizedEmpresa,
        notificationsSeenAt: new Date(),
        createdAt: new Date(),
      };

      await db.collection("users").insertOne(document);

      await companyService.createCompany(sanitizedEmpresa);

      cacheService.clear("all_users");

      logger.info("User created", {
        username: sanitizedUsername,
        role: sanitizedRole,
        empresa: sanitizedEmpresa,
      });

      return {
        username: sanitizedUsername,
        role: sanitizedRole,
        empresa: sanitizedEmpresa,
      };
    } catch (error) {
      if (error.statusCode) throw error;

      logger.error("Failed to create user", error);
      throw createError("Error creando usuario", 500);
    }
  }

  async deleteUser(username) {
    try {
      if (!username) {
        throw createError("username es obligatorio", 400);
      }

      const sanitizedUsername = sanitizeString(username);
      if (!sanitizedUsername) {
        throw createError("username invalido", 400);
      }

      performanceMonitor.trackDbQuery();

      const db = await connect();
      const existing = await db
        .collection("users")
        .findOne({ username: sanitizedUsername });

      if (!existing) {
        throw createError("Usuario no existe", 404);
      }

      const result = await db
        .collection("users")
        .deleteOne({ username: sanitizedUsername });

      if (result.deletedCount === 0) {
        throw createError("No se pudo eliminar el usuario", 500);
      }

      await Promise.all([
        db
          .collection("certificates")
          .updateMany(
            { assignedUsers: sanitizedUsername },
            { $pull: { assignedUsers: sanitizedUsername } },
          ),
        db
          .collection("drafts")
          .updateMany(
            { assignedUsers: sanitizedUsername },
            { $pull: { assignedUsers: sanitizedUsername } },
          ),
      ]);

      cacheService.clear("all_users");
      cacheService.clear("all_certificates");
      cacheService.clear("all_drafts");

      logger.info("User deleted", { username: sanitizedUsername });

      return { ok: true };
    } catch (error) {
      if (error.statusCode) throw error;

      logger.error("Failed to delete user", error);
      throw createError("Error eliminando usuario", 500);
    }
  }
}


export const userService = new UserService();
