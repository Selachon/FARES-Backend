import { createError } from "./utils.js";

// Temporary demo rollout. Keep in sync with the frontend inventory access policy.
export const canAccessInventory = (user) =>
  user?.role === "ADMIN" ||
  (user?.role === "USER" && user?.username === "fares");

// Applied after authentication, before every inventory endpoint (including images).
export function inventoryAccessGuard(req, res, next) {
  if (!canAccessInventory(req.user)) {
    return next(createError("Inventario no disponible para este usuario", 403));
  }
  if (!["GET", "HEAD", "OPTIONS"].includes(req.method) && req.user.role !== "ADMIN") {
    return next(createError("Sólo ADMIN puede administrar inventario", 403));
  }
  next();
}
