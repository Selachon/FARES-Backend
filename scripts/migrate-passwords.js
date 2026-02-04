// Script de migración de contraseñas en texto plano a bcrypt
// Ejecutar: node scripts/migrate-passwords.js

import { connect } from '../src/db.js';
import bcrypt from 'bcryptjs';
import { logger } from '../src/utils.js';

async function migratePasswords() {
  try {
    logger.info('Iniciando migración de contraseñas...');
    
    const db = await connect();
    const users = await db.collection('users').find({}).toArray();
    
    let migratedCount = 0;
    let skippedCount = 0;
    let errorCount = 0;
    
    for (const user of users) {
      const password = String(user.password || '').trim();
      
      if (!password) {
        logger.warn(`Usuario sin contraseña: ${user.username}`);
        skippedCount++;
        continue;
      }
      
      // Verificar si ya es bcrypt hash
      const isHashed = password.startsWith('$2a$') || password.startsWith('$2b$');
      
      if (isHashed) {
        logger.info(`Usuario ya tiene hash bcrypt: ${user.username}`);
        skippedCount++;
        continue;
      }
      
      try {
        // Hashear contraseña en texto plano
        const hash = await bcrypt.hash(password, 10);
        
        await db.collection('users').updateOne(
          { _id: user._id },
          { 
            $set: { 
              password: hash, 
              updatedAt: new Date(),
              passwordMigratedAt: new Date()
            } 
          }
        );
        
        logger.info(`✅ Contraseña migrada para usuario: ${user.username}`);
        migratedCount++;
      } catch (error) {
        logger.error(`❌ Error migrando usuario ${user.username}:`, error);
        errorCount++;
      }
    }
    
    logger.info('='.repeat(60));
    logger.info('Migración de contraseñas completada');
    logger.info(`Total de usuarios: ${users.length}`);
    logger.info(`Migrados: ${migratedCount}`);
    logger.info(`Omitidos (ya hasheados o sin password): ${skippedCount}`);
    logger.info(`Errores: ${errorCount}`);
    logger.info('='.repeat(60));
    
    if (errorCount > 0) {
      logger.warn('⚠️  Algunos usuarios no pudieron ser migrados. Revisar logs.');
      process.exit(1);
    }
    
    process.exit(0);
  } catch (error) {
    logger.error('Error fatal en migración:', error);
    process.exit(1);
  }
}

// Ejecutar migración
migratePasswords();
