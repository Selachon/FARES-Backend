# FARES Backend

API REST para el sistema FARES de gestion de certificados de inspeccion tecnica.

## Stack

- **Runtime**: Node.js 18+
- **Framework**: Express.js
- **Base de datos**: MongoDB Atlas
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
- MongoDB Atlas (o local)
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
| `MONGODB_URI` | URI de conexion a MongoDB |
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

El proyecto esta configurado para Render.com:

1. Crear Web Service en Render
2. Conectar repositorio GitHub
3. Build command: `npm install`
4. Start command: `npm start`
5. Configurar variables de entorno en dashboard

## Troubleshooting

### Cold start en Render
El plan gratuito de Render duerme el servicio despues de 15 min de inactividad. El primer request puede tardar 30-60 segundos.

### Token de Google Drive expirado
Si los uploads fallan, regenerar el refresh token con `get-token.js`:
```bash
node get-token.js
```

### Conexion MongoDB rechazada
Verificar que la IP del servidor este en la allowlist de MongoDB Atlas.

## Contacto

Para soporte tecnico o consultas sobre el proyecto, contactar al equipo de desarrollo.
