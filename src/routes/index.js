/**
 * Main router index - composes all route modules.
 * 
 * Current state: Using monolithic api.js while gradually migrating to modules.
 * Target structure:
 *   - auth.js: login, logout, users
 *   - certificates.js: CRUD, download
 *   - drafts.js: CRUD, publish
 *   - admin.js: users, companies, drive config
 *   - app.js: mobile app endpoints (device auth, sync)
 *   - notifications.js: SSE, pending, seen
 */
import apiRoutes from "./api.js";

// For now, export the monolithic router.
// As modules are split out, they will be imported and mounted here.
export default apiRoutes;

// Future structure:
// import authRoutes from "./auth.js";
// import certificateRoutes from "./certificates.js";
// import draftRoutes from "./drafts.js";
// import adminRoutes from "./admin.js";
// import appRoutes from "./app.js";
// import notificationRoutes from "./notifications.js";
//
// const router = express.Router();
// router.use("/auth", authRoutes);
// router.use("/certificates", certificateRoutes);
// router.use("/drafts", draftRoutes);
// router.use("/admin", adminRoutes);
// router.use("/app", appRoutes);
// router.use("/notifications", notificationRoutes);
// export default router;
