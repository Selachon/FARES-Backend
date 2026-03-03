/**
 * Authentication routes: login, logout, user management.
 */
import express from "express";
import jwt from "jsonwebtoken";
import { config } from "../config.js";
import { asyncHandler } from "../utils.js";
import { userService } from "../userService.js";
import { adminGuard, authenticate } from "../middleware.js";
import { loginLimiter } from "./shared.js";

const router = express.Router();

// Login with username/password, returns user profile and sets JWT cookie.
router.post(
  "/login",
  loginLimiter,
  asyncHandler(async (req, res) => {
    const { username, password } = req.body;
    // Hard type-check credentials to reduce NoSQL injection vectors.
    if (typeof username !== "string" || typeof password !== "string") {
      return res.status(400).json({ message: "Credenciales inválidas", code: "BAD_REQUEST" });
    }
    const user = await userService.authenticateUser(username, password);
    
    // Issue session JWT.
    const token = jwt.sign(
      {
        username: user.username,
        role: user.role,
        empresa: user.empresa
      },
      config.jwt.secret,
      { expiresIn: config.jwt.expiresIn }
    );
    
    // Store token in HTTP-only cookie.
    res.cookie(config.jwt.cookie.name, token, {
      httpOnly: config.jwt.cookie.httpOnly,
      secure: config.jwt.cookie.secure,
      sameSite: config.jwt.cookie.sameSite,
      maxAge: config.jwt.cookie.maxAge
    });
    
    // Return user profile without exposing token in JSON body.
    res.json(user);
  }),
);

// Logout: clear session cookie.
router.post(
  "/logout",
  asyncHandler(async (req, res) => {
    res.clearCookie(config.jwt.cookie.name);
    res.json({ message: "Sesión cerrada exitosamente" });
  }),
);

// Get all users (ADMIN only).
router.get(
  "/users",
  adminGuard,
  asyncHandler(async (req, res) => {
    const users = await userService.getAllUsers();
    res.json(users);
  }),
);

export default router;
