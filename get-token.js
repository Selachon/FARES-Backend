// Utilidad para obtener token de OAuth de Google
// Genera URL de autorización y maneja callback para obtener refresh token
import { google } from "googleapis";
import http from "http";
import dotenv from "dotenv";
dotenv.config();

// Obtener credenciales OAuth desde variables de entorno
const CLIENT_ID = process.env.GOOGLE_OAUTH_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
// URI de redirección local para manejar callback de OAuth
const REDIRECT_URI = "http://localhost:3007/oauth2/callback";
// Alcances (scopes) necesarios para acceder a Google Drive
const SCOPES = ["https://www.googleapis.com/auth/drive"];

// Crear cliente OAuth2 de Google con las credenciales
const oAuth2Client = new google.auth.OAuth2(
  CLIENT_ID,
  CLIENT_SECRET,
  REDIRECT_URI
);

// Generar URL de autorización con parámetros necesarios
const authUrl = oAuth2Client.generateAuthUrl({
  access_type: "offline",    // Necesario para obtener refresh_token
  prompt: "consent",         // Forzar pantalla de consentimiento
  scope: SCOPES,             // Alcances de la API
});
console.log("\nAutoriza visitando este enlace:\n");
console.log(authUrl);

// Crear servidor HTTP local para recibir el callback de OAuth
const server = http.createServer(async (req, res) => {
  if (req.url.startsWith("/oauth2/callback")) {
    const url = new URL(req.url, REDIRECT_URI);
    const code = url.searchParams.get("code");
    
    try {
      // Intercambiar código de autorización por tokens de acceso
      const { tokens } = await oAuth2Client.getToken(code);
      console.log("\nTokens obtenidos:");
      console.log(tokens);
      
      // Si se obtuvo refresh_token, mostrar instrucciones para guardarlo
      if (tokens.refresh_token) {
        console.log(
          `\nGuarda en tu .env:\nGOOGLE_OAUTH_REFRESH_TOKEN=${tokens.refresh_token}\n`
        );
      } else {
        console.warn("\n⚠️  No se obtuvo refresh_token. Asegúrate de usar 'prompt: consent'");
      }
      
      // Enviar respuesta al navegador
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("OK. Revisa la consola y copia el refresh_token. Puedes cerrar esta pestaña.");
    } catch (error) {
      console.error("Error canjeando código:", error);
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("Error. Revisa la consola.");
    } finally {
      // Cerrar servidor después de procesar el callback
      server.close();
    }
    return;
  }
  // Para rutas no encontradas, devolver 404
  res.writeHead(404);
  res.end();
});

// Iniciar servidor en puerto 3007 para esperar el callback
server.listen(3007, () =>
  console.log("Esperando callback en http://localhost:3007/oauth2/callback")
);
