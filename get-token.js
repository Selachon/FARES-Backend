// get-token.js
import { google } from "googleapis";
import http from "http";
import dotenv from "dotenv";
dotenv.config();

const CLIENT_ID = process.env.GOOGLE_OAUTH_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
const REDIRECT_URI = "http://localhost:3007/oauth2/callback";
const SCOPES = ["https://www.googleapis.com/auth/drive"]; // scope amplio y estable

const oAuth2Client = new google.auth.OAuth2(
  CLIENT_ID,
  CLIENT_SECRET,
  REDIRECT_URI
);

// 1) Muestra la URL para autorizar
const authUrl = oAuth2Client.generateAuthUrl({
  access_type: "offline",
  prompt: "consent",
  scope: SCOPES,
});
console.log("\nAutoriza visitando este enlace:\n");
console.log(authUrl);

// 2) Servidor local para recibir el code y canjear tokens
const server = http.createServer(async (req, res) => {
  if (req.url.startsWith("/oauth2/callback")) {
    const url = new URL(req.url, REDIRECT_URI);
    const code = url.searchParams.get("code");
    try {
      const { tokens } = await oAuth2Client.getToken(code);
      console.log("\nTokens obtenidos:");
      console.log(tokens);
      console.log(
        `\nGuarda en tu .env:\nGOOGLE_OAUTH_REFRESH_TOKEN=${tokens.refresh_token}\n`
      );
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("OK. Revisa la consola y copia el refresh_token. Puedes cerrar esta pestaña.");
    } catch (e) {
      console.error("Error canjeando código:", e);
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("Error. Revisa la consola.");
    } finally {
      server.close();
    }
    return;
  }
  res.writeHead(404);
  res.end();
});

server.listen(3007, () =>
  console.log("Esperando callback en http://localhost:3007/oauth2/callback")
);
