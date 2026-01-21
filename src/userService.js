import { connect } from "./db.js";
import bcrypt from "bcryptjs";
import { logger, sanitizeString, parseUserList, createError } from "./utils.js";
import { cacheService } from "./cacheService.js";
import { performanceMonitor } from "./performanceMonitor.js";

// Servicio para gestión de usuarios del sistema
class UserService {
  constructor() {
    this.collectionName = "users"; // Nombre de la colección en MongoDB
  }

  // Obtiene todos los usuarios sin contraseñas (con caché para rendimiento)
  async getAllUsers() {
    try {
      performanceMonitor.trackDbQuery(); // Registra operación de BD para métricas

      // Usa caché para reducir carga en base de datos
      return await cacheService.getOrSet(
        "all_users", // Clave de caché
        async () => {
          const db = await connect();
          const users = await db
            .collection("users")
            .find({}, { projection: { password: 0 } }) // Excluye contraseñas
            .toArray();

          // Normaliza y limpia datos de usuarios
          return users.map((user) => ({
            ...user,
            empresa: sanitizeString(user.empresa),
            username: sanitizeString(user.username),
            role: sanitizeString(user.role),
          }));
        },
        10 * 60 * 1000, // Cache por 10 minutos
      );
    } catch (error) {
      logger.error("Failed to get all users", error);
      throw createError("Error obteniendo usuarios", 500);
    }
  }

  // Autentica usuario contra base de datos
  async authenticateUser(username, password) {
    try {
      // Validación básica de entrada
      if (!username || !password) {
        throw createError("Usuario y clave obligatorios", 400);
      }

      const db = await connect();
      // Busca usuario por username (limpiado)
      const user = await db.collection("users").findOne({
        username: sanitizeString(username),
      });

      if (!user) {
        throw createError("Usuario no existe", 404);
      }

      // Si el usuario existe pero no tiene clave asignada
      if (!user.password || String(user.password).trim() === "") {
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

      // Verifica contraseña (con hash o texto plano para compatibilidad)
      const isPasswordValid = await this.validatePassword(
        password,
        user.password,
      );

      if (!isPasswordValid) {
        throw createError("Clave incorrecta", 401, "INVALID_CREDENTIALS");
      }

      // Retorna datos básicos del usuario (sin contraseña)
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

  // Valida contraseña detectando si está hasheada o en texto plano
  async validatePassword(inputPassword, storedPassword) {
    if (!storedPassword || typeof storedPassword !== "string") return false;

    const looksHashed =
      storedPassword.startsWith("$2a$") || storedPassword.startsWith("$2b$");

    return looksHashed
      ? await bcrypt.compare(inputPassword, storedPassword)
      : inputPassword === storedPassword;
  }

  // Valida que todos los usuarios existan y pertenezcan a la empresa indicada
  async validateUsersExist(usernames, empresa) {
    try {
      performanceMonitor.trackDbQuery();

      // Crea clave de caché única para esta validación específica
      const cacheKey = `user_validation_${usernames.join(",")}_${empresa}`;

      return await cacheService.getOrSet(
        cacheKey,
        async () => {
          const db = await connect();
          // Busca todos los usuarios en una sola consulta
          const users = await db
            .collection("users")
            .find({ username: { $in: usernames } })
            .toArray();

          const empresaTarget = sanitizeString(empresa).toUpperCase();

          // Verifica que todos los usuarios pertenezcan a la misma empresa
          const hasInvalidUser = users.some((user) => {
            const userEmpresa = sanitizeString(user.empresa).toUpperCase();
            return userEmpresa !== empresaTarget;
          });

          // Si faltan usuarios o hay alguno de empresa incorrecta, lanza error
          if (users.length !== usernames.length || hasInvalidUser) {
            throw createError(
              "Los usuarios asignados deben existir y pertenecer a la Empresa seleccionada",
              400,
              "INVALID_USER_ASSIGNMENT",
            );
          }

          return true;
        },
        5 * 60 * 1000, // Cache por 5 minutos
      );
    } catch (error) {
      if (error.statusCode) throw error;

      logger.error("User validation failed", error);
      throw createError("Error validando usuarios", 500);
    }
  }

  // Actualiza contraseña de usuario (convalidación completa)
  async updateUserPassword(username, newPassword) {
    try {
      // Validaciones de entrada
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

      const db = await connect();
      // Verifica que el usuario exista
      const user = await db.collection("users").findOne({
        username: sanitizeString(username),
      });

      if (!user) {
        throw createError("Usuario no existe", 404);
      }

      // Crea hash seguro de la nueva contraseña
      const hash = await bcrypt.hash(newPassword, 10);

      // Actualiza contraseña en base de datos
      await db
        .collection("users")
        .updateOne(
          { username: sanitizeString(username) },
          { $set: { password: hash, updatedAt: new Date() } },
        );

      // Limpia caché de usuarios para reflejar cambios
      cacheService.clear("all_users");
      logger.info("User password updated", { username });
      return { ok: true };
    } catch (error) {
      if (error.statusCode) throw error;

      logger.error("Password update failed", error);
      throw createError("Error actualizando la clave", 500);
    }
  }

  // Actualiza contraseña de usuario (versión admin, sin longitud mínima)
  async adminUpdateUserPassword(username, newPassword) {
    try {
      // Validaciones de entrada
      if (!username || !newPassword) {
        throw createError("username y newPassword son obligatorios", 400);
      }

      const db = await connect();
      // Verifica que el usuario exista
      const user = await db.collection("users").findOne({
        username: sanitizeString(username),
      });

      if (!user) {
        throw createError("Usuario no existe", 404);
      }

      // Crea hash seguro de la nueva contraseña
      const hash = await bcrypt.hash(newPassword, 10);

      // Actualiza contraseña en base de datos
      await db
        .collection("users")
        .updateOne(
          { username: sanitizeString(username) },
          { $set: { password: hash, updatedAt: new Date() } },
        );

      logger.info("Admin updated user password", { username });
      return { ok: true };
    } catch (error) {
      if (error.statusCode) throw error;

      logger.error("Admin password update failed", error);
      throw createError("Error actualizando la clave", 500);
    }
  }
}

// Exporta instancia única del servicio (singleton)
export const userService = new UserService();
