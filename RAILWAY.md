# Railway Deployment

This repo is split into three deployable pieces:

- `FARES-Backend`: Express API service.
- `FARES-Frontend`: Vite static frontend served by `vite preview` on Railway.
- `FARES-App`: Expo mobile app; not deployed to Railway, but it must point to the Railway API when building.

## Backend service

Railway service root: `FARES-Backend`.

Build/start are defined in `FARES-Backend/railway.json`:

- Build: Railpack.
- Start: `npm start`.
- Healthcheck: `/healthz`.

Required Railway variables:

```env
NODE_ENV=production
LOCAL_DEV=0
HOST=0.0.0.0
JWT_SECRET=<secure random value>
GOOGLE_OAUTH_CLIENT_ID=<google oauth client id>
GOOGLE_OAUTH_CLIENT_SECRET=<google oauth secret>
GOOGLE_OAUTH_REFRESH_TOKEN=<google refresh token>
APP_API_KEY=<legacy app key if still needed>
REQUIRE_ENROLLMENT_TOKEN=0
CORS_ALLOWED_ORIGINS=https://<frontend-service>.up.railway.app,https://faresbcs.com,https://www.faresbcs.com
ALLOW_RAILWAY_ORIGINS=1
ALLOW_RENDER_ORIGINS=0
EMAIL_HOST=smtp-relay.brevo.com
EMAIL_PORT=587
EMAIL_SECURE=false
EMAIL_USER=<smtp user>
EMAIL_PASS=<smtp password>
EMAIL_FROM=admin@faresbcs.com
EMAIL_TO=admin@faresbcs.com
BREVO_API_KEY=<brevo key>
DRIVE_SHARE_TYPE=anyone
DRIVE_SHARE_ROLE=writer
```

For MongoDB, prefer Railway's service reference:

```env
MONGODB_URI=${{MongoDB.MONGO_URL}}
```

The backend also supports `MONGO_URL` directly if Railway injects it into the service.

## Frontend service

Railway service root: `FARES-Frontend`.

Build/start are defined in `FARES-Frontend/railway.json`:

- Build: `npm run build`.
- Start: `npm start`.
- Healthcheck: `/`.

Required Railway variables:

```env
VITE_API_URL=https://<backend-service>.up.railway.app/api
VITE_GOOGLE_CLIENT_ID=<google client id if used>
VITE_GOOGLE_API_KEY=<google api key if used>
```

## App builds

When building the Expo app, set:

```env
EXPO_PUBLIC_API_URL=https://<backend-service>.up.railway.app/api
```

## MongoDB migration

The migration script copies the current production database into Railway MongoDB. It reads from the current Atlas/source URI and replaces collections in the target Railway DB.

Dry run from `FARES-Backend`:

```bash
SOURCE_MONGODB_URI='<current atlas uri>' \
TARGET_MONGODB_URI='<railway mongo url>' \
SOURCE_MONGODB_DB=fares \
TARGET_MONGODB_DB=fares \
npm run migrate:mongo:railway
```

Execute migration:

```bash
SOURCE_MONGODB_URI='<current atlas uri>' \
TARGET_MONGODB_URI='<railway mongo url>' \
SOURCE_MONGODB_DB=fares \
TARGET_MONGODB_DB=fares \
CONFIRM_MONGODB_MIGRATION=1 \
TARGET_INDEX_MIN_FREE_DISK_MB=50 \
npm run migrate:mongo:railway
```

Notes:

- The script defaults to dry-run until `CONFIRM_MONGODB_MIGRATION=1` is set.
- The target collections are dropped and recreated in replace mode, so the target reflects the latest source state.
- Keep the old DB untouched until Backend, Frontend, and App are all confirmed against Railway.
- If Railway MongoDB refuses to create indexes because of the default free-disk threshold, set `TARGET_INDEX_MIN_FREE_DISK_MB=50` during the confirmed migration.
