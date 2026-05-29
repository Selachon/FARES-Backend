# FARES Backend

API REST para el sistema FARES de gestion de certificados de inspeccion tecnica.

## Stack

- **Runtime**: Node.js 18+
- **Framework**: Express.js
- **Base de datos**: MongoDB Atlas / Railway MongoDB
- **Almacenamiento**: Google Drive API
- **Autenticacion**: JWT (cookies HttpOnly)
- **Email**: Brevo/SMTP

## Estructura del proyecto

```
src/
  config.js           # Configuracion centralizada desde env
  db.js               # Conexion MongoDB + indexes + seed
  server.js           # Express app setup
  middleware.js       # Auth guards, CORS, CSRF, error handling
  routes/
    api.js            # Router principal (auth, certs, drafts, admin, app)
  *Service.js         # Logica de negocio por dominio
  driveService.js     # Integracion Google Drive
  emailService.js     # Envio de correos
```

## Requisitos

- Node.js 18+
- MongoDB Atlas, Railway MongoDB o local
- Cuenta Google Cloud con Drive API habilitada
- Cuenta Brevo (opcional, para emails)

## Instalacion

```bash
npm install
cp .env.example .env
# Editar .env con credenciales reales
```

## Variables de entorno requeridas

| Variable | Descripcion |
|----------|-------------|
| `MONGODB_URI` / `MONGO_URL` | URI de conexion a MongoDB |
| `JWT_SECRET` | Secreto para firmar tokens de sesion |
| `GOOGLE_OAUTH_CLIENT_ID` | Client ID de Google OAuth |
| `GOOGLE_OAUTH_CLIENT_SECRET` | Client Secret de Google OAuth |
| `GOOGLE_OAUTH_REFRESH_TOKEN` | Refresh token para Drive API |

Ver `.env.example` para lista completa.

## Ejecucion

```bash
# Desarrollo (con hot reload)
npm run dev

# Produccion
npm start

# Seed de datos demo
SEED_DEMO=1 npm start
```

## Cargue masivo desde Excel

Para inyectar certificados directamente en MongoDB desde un archivo Excel:

```bash
# 1) Validar sin escribir en DB (dry-run)
npm run import:certs:excel -- --excel "/ruta/archivo.xlsx"

# 2) Ejecutar insercion/upsert real
npm run import:certs:excel -- --excel "/ruta/archivo.xlsx" --apply

# 3) Cargar todos los Excel de una carpeta
npm run import:certs:excel -- --dir "/ruta/carpeta-con-xlsx" --apply
```

Opciones utiles:

- `--uri`: URI MongoDB (si no quieres usar `MONGODB_URI` del `.env`)
- `--db`: base de datos destino (default `fares`)
- `--sheet`: hoja especifica del Excel (si no, usa la primera)
- `--collection`: coleccion destino (default `certificates`)
- `--dir`: procesa todos los `.xlsx` de una carpeta

El script mantiene la estructura de los certificados de la app y evita duplicados usando la llave `(empresa, numCert, serial)`.

## Endpoints principales

### Autenticacion
- `POST /api/auth/login` - Login con usuario/password
- `POST /api/auth/logout` - Cerrar sesion
- `GET /api/auth/users` - Listar usuarios (solo ADMIN)

### Certificados
- `GET /api/certificates` - Listar certificados (filtrado por rol)
- `POST /api/certificates` - Crear certificado (ADMIN)
- `PUT /api/certificates/:id` - Actualizar certificado (ADMIN)
- `DELETE /api/certificates/bulk` - Eliminar multiples (ADMIN)
- `POST /api/certificates/download` - Descargar ZIP (USER)

### Borradores
- `GET /api/drafts` - Listar borradores (ADMIN)
- `POST /api/drafts` - Crear borrador (ADMIN)
- `PUT /api/drafts/:id` - Actualizar borrador (ADMIN)
- `POST /api/drafts/:id/publish` - Publicar como certificado (ADMIN)

### App Movil
- `POST /api/app/auth/device-register` - Registrar dispositivo
- `POST /api/app/auth/token` - Obtener token de acceso
- `POST /api/app/drafts` - Sincronizar inspeccion offline
- `GET /api/app/companies` - Listar empresas
- `GET /api/app/sites` - Listar sitios

### Admin
- `POST /api/admin/users` - Crear usuario
- `DELETE /api/admin/users/:username` - Eliminar usuario
- `PUT /api/admin/users/password` - Cambiar password
- `GET /api/admin/companies` - Listar empresas
- `POST /api/admin/companies` - Crear empresa
- `GET /api/admin/drive-folders` - Config carpetas Drive
- `PUT /api/admin/drive-folders` - Actualizar config Drive

## Roles

| Rol | Permisos |
|-----|----------|
| `ADMIN` | Acceso total: crear/editar/eliminar certificados, usuarios, empresas |
| `USER` | Ver certificados asignados, descargar documentos |

## Seguridad

- CSRF protection via Origin/Referer validation
- Rate limiting en login y endpoints sensibles
- Cookies HttpOnly + Secure + SameSite
- Enrollment tokens para registro de dispositivos moviles
- Passwords hasheados con bcrypt

## Deployment

El proyecto esta preparado para Railway:

1. Crear servicio desde el directorio `FARES-Backend`
2. Railway usa `railway.json` con Railpack, `npm start` y healthcheck `/healthz`
3. Agregar MongoDB en Railway y configurar `MONGODB_URI=${{MongoDB.MONGO_URL}}` o exponer `MONGO_URL`
4. Configurar secretos y `CORS_ALLOWED_ORIGINS` en el dashboard
5. Ver `RAILWAY.md` para la migracion de datos

## Troubleshooting

### Servicio iniciando
El primer request puede tardar mas si Railway esta arrancando una nueva instancia.

### Token de Google Drive expirado
Si los uploads fallan, regenerar el refresh token con `get-token.js`:
```bash
node get-token.js
```

### Conexion MongoDB rechazada
Verificar que `MONGODB_URI` o `MONGO_URL` apunte a la base correcta. Si se usa Atlas, revisar la allowlist de red.

## Contacto

Para soporte tecnico o consultas sobre el proyecto, contactar al equipo de desarrollo.
