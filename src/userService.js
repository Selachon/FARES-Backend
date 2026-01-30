// Servicio de gestión de usuarios
// Maneja autenticación, validación, y operaciones CRUD de usuarios
import { connect } from "./db.js";
import bcrypt from "bcryptjs";
import { logger, sanitizeString, parseUserList, createError } from "./utils.js";
import { cacheService } from "./cacheService.js";
import { performanceMonitor } from "./performanceMonitor.js";

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

      if (!user) {
        throw createError("Usuario no existe", 404);
      }

      const userPassword = String(user.password || "").trim();
      if (!userPassword) {
        logger.warn("Login attempted for user without password", {
          username: user.username,
          empresa: user.empresa,
        });
        throw createError(
          "El usuario no tiene clave. Solicítela al personal de FARES.",
          401,
          "NO_PASSWORD",
        );
      }

      const isPasswordValid = await this.validatePassword(password, userPassword);

      if (!isPasswordValid) {
        throw createError("Clave incorrecta", 401, "INVALID_CREDENTIALS");
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

    const looksHashed =
      storedPassword.startsWith("$2a$") || storedPassword.startsWith("$2b$");

    return looksHashed
      ? await bcrypt.compare(inputPassword, storedPassword)
      : inputPassword === storedPassword;
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

      if (newPassword.length < 4) {
        throw createError(
          "La nueva clave debe tener al menos 4 caracteres",
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
}


export const userService = new UserService();
