import { google } from "googleapis";
import readline from "readline";
import dotenv from "dotenv";
dotenv.config();

// Carga los datos de tu .env
const CLIENT_ID = process.env.GOOGLE_OAUTH_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
const REDIRECT_URI = "urn:ietf:wg:oauth:2.0:oob"; // flujo sin servidor web

// Crea el cliente OAuth2
const oAuth2Client = new google.auth.OAuth2(
  CLIENT_ID,
  CLIENT_SECRET,
  REDIRECT_URI
);

// Permisos para subir a Drive
const SCOPES = ["https://www.googleapis.com/auth/drive"];

// Paso 1: Generar la URL de autenticación
const authUrl = oAuth2Client.generateAuthUrl({
  access_type: "offline",
  scope: SCOPES,
  prompt: "consent", // para forzar refresh_token
});

console.log("\n🌐 Autoriza esta app visitando este enlace:\n");
console.log(authUrl);
console.log("\nLuego pega aquí el código que te dé Google:\n");

// Paso 2: Leer el código que devuelve Google
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});
rl.question("Código: ", async (code) => {
  try {
    const { tokens } = await oAuth2Client.getToken(code);
    console.log("\n✅ Tokens obtenidos:");
    console.log(tokens);
    console.log("\n📌 Guarda el `refresh_token` en tu .env como:");
    console.log(`GOOGLE_OAUTH_REFRESH_TOKEN=${tokens.refresh_token}`);
  } catch (err) {
    console.error("❌ Error obteniendo el token:", err);
  }
  rl.close();
});
