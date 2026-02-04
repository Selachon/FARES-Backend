# Migración de Seguridad - Sistema de Autenticación FARES

## Resumen de Cambios

Se ha implementado una revisión completa del sistema de autenticación para corregir vulnerabilidades críticas identificadas en la auditoría de seguridad.

### Cambios Principales

1. **Autenticación JWT con cookies httpOnly** - Reemplaza el sistema anterior basado en headers manipulables
2. **Rate limiting en login** - Protección contra ataques de fuerza bruta
3. **Eliminación de contraseñas en texto plano** - Solo se aceptan contraseñas hasheadas con bcrypt
4. **Mensajes de error unificados** - Previene enumeración de usuarios
5. **Headers de seguridad** - Implementación de Helmet
6. **Autenticación obligatoria** - Todos los endpoints sensibles ahora requieren autenticación

---

## Pasos de Migración

### 1. Variables de Entorno (CRÍTICO)

Agregar las siguientes variables al archivo `.env`:

```bash
# Generar JWT_SECRET
node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"

# Generar APP_API_KEY
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Agregar al `.env`:
```
JWT_SECRET=<valor_generado_arriba>
APP_API_KEY=<valor_generado_arriba>
```

**IMPORTANTE:** Sin estas variables, el servidor NO arrancará.

### 2. Migración de Contraseñas en Base de Datos

Si existen usuarios con contraseñas en texto plano, ejecutar el siguiente script de migración:

```javascript
// scripts/migrate-passwords.js
import { connect } from './src/db.js';
import bcrypt from 'bcryptjs';

async function migratePasswords() {
  const db = await connect();
  const users = await db.collection('users').find({}).toArray();
  
  for (const user of users) {
    const password = String(user.password || '').trim();
    
    // Si no es bcrypt hash, hashear
    if (password && !password.startsWith('$2a$') && !password.startsWith('$2b$')) {
      const hash = await bcrypt.hash(password, 10);
      await db.collection('users').updateOne(
        { _id: user._id },
        { $set: { password: hash, updatedAt: new Date() } }
      );
      console.log(`Migrated password for user: ${user.username}`);
    }
  }
  
  console.log('Password migration complete');
  process.exit(0);
}

migratePasswords().catch(console.error);
```

Ejecutar:
```bash
cd FARES-Backend
node scripts/migrate-passwords.js
```

### 3. Actualizar Política de Contraseñas

La longitud mínima de contraseña cambió de **4 a 8 caracteres**.

Informar a los usuarios que las nuevas contraseñas deben tener al menos 8 caracteres.

### 4. Configuración de CORS

Verificar que los orígenes permitidos en `config.js` incluyan el dominio del frontend:

```javascript
cors: {
  allowedOrigins: [
    "https://faresbcs.com",
    "https://www.faresbcs.com",
    "http://localhost:5173", // desarrollo
  ],
}
```

### 5. Despliegue

**Orden de despliegue:**

1. **Backend primero** - Desplegar con las nuevas variables de entorno
2. **Frontend después** - El frontend es compatible con ambos sistemas durante la transición

**Verificación post-despliegue:**

```bash
# Test de login
curl -X POST https://api.faresbcs.com/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"test","password":"test123"}' \
  -c cookies.txt

# Test de endpoint protegido
curl https://api.faresbcs.com/api/certificates \
  -b cookies.txt
```

---

## Cambios de Comportamiento

### Para Usuarios Finales

- **Login:** Funciona igual, pero ahora con protección contra fuerza bruta (5 intentos cada 15 minutos)
- **Sesión:** Se mantiene en cookie httpOnly (más segura que localStorage)
- **Logout:** Funciona igual
- **Contraseñas:** Mínimo 8 caracteres (antes 4)

### Para Desarrolladores

#### Antes (INSEGURO):
```javascript
// Frontend enviaba headers manipulables
fetch('/api/certificates', {
  headers: { 'x-role': 'ADMIN' } // ❌ Cualquiera podía ser admin
})
```

#### Ahora (SEGURO):
```javascript
// Frontend usa cookies automáticas
fetch('/api/certificates', {
  credentials: 'include' // ✅ Cookie httpOnly con JWT firmado
})
```

#### Endpoints que ahora requieren autenticación:

- `GET /api/auth/users` - Requiere autenticación
- `GET /api/certificates` - Requiere autenticación
- `POST /api/certificates` - Requiere rol ADMIN
- `DELETE /api/certificates/bulk` - Requiere rol ADMIN
- Todos los endpoints de `/api/drafts/*` - Requieren rol ADMIN
- Todos los endpoints de `/api/admin/*` - Requieren rol ADMIN

---

## Vulnerabilidades Corregidas

| ID | Vulnerabilidad | Severidad | Estado |
|----|---------------|-----------|--------|
| C1 | Suplantación de rol del cliente | CRÍTICO | ✅ CORREGIDO |
| C2 | Contraseñas en texto plano | CRÍTICO | ✅ CORREGIDO |
| C3 | Sin rate limiting en login | CRÍTICO | ✅ CORREGIDO |
| C4 | Enumeración de usuarios | CRÍTICO | ✅ CORREGIDO |
| H1 | API key hardcodeada | ALTO | ✅ CORREGIDO |
| H2 | Endpoints sin autenticación | ALTO | ✅ CORREGIDO |
| H3 | Sesión en localStorage | ALTO | ✅ CORREGIDO |
| H4 | Política de contraseñas débil | ALTO | ✅ CORREGIDO |
| M3 | Sin headers de seguridad | MEDIO | ✅ CORREGIDO |

---

## Rollback (Si es necesario)

Si se detectan problemas críticos:

1. **Revertir backend** al commit anterior
2. **Restaurar .env** sin JWT_SECRET y APP_API_KEY
3. **Notificar** al equipo de desarrollo

**NOTA:** El rollback dejará el sistema vulnerable. Solo usar en emergencias.

---

## Soporte

Para problemas o preguntas sobre la migración:

1. Revisar logs del servidor: `pm2 logs` o `docker logs`
2. Verificar variables de entorno: `printenv | grep JWT`
3. Contactar al equipo de desarrollo

---

## Checklist de Migración

- [ ] Variables JWT_SECRET y APP_API_KEY agregadas al .env
- [ ] Script de migración de contraseñas ejecutado
- [ ] Backend desplegado y funcionando
- [ ] Frontend desplegado
- [ ] Login probado exitosamente
- [ ] Endpoints protegidos verificados
- [ ] Rate limiting probado (5 intentos fallidos)
- [ ] Usuarios notificados sobre nueva política de contraseñas

---

**Fecha de implementación:** 2026-02-03  
**Versión:** 2.0.0-security  
**Responsable:** Equipo de Desarrollo FARES
