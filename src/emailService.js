// src/emailService.js
import nodemailer from "nodemailer";
import { config } from "./config.js";
import { logger, validateEmail, escapeHtml } from "./utils.js";

function redactSecrets(str) {
  if (!str) return str;
  return String(str).slice(0, 4) + "****";
}

class EmailService {
  constructor() {
    this.transporter = null;
    this.lastVerify = { ok: false, at: null, error: null };
    this.init();
  }

  init() {
    const email = config.email;

    // Validación de config mínima
    if (!email?.host || !email?.port || !email?.user || !email?.pass) {
      logger.warn("Email service not configured - missing env vars", {
        host: email?.host,
        port: email?.port,
        user: email?.user ? redactSecrets(email.user) : null,
        hasPass: Boolean(email?.pass),
      });
      return;
    }

    // Normalización defensiva (por si algo llega como string)
    const port = Number(email.port);
    const secure = Boolean(email.secure);

    this.transporter = nodemailer.createTransport({
      host: email.host,
      port,
      secure, // true sólo si 465 (SSL directo)
      auth: {
        user: email.user,
        pass: email.pass,
      },

      // STARTTLS explícito para 587 (Brevo)
      requireTLS: port === 587,

      tls: {
        servername: email.host,
        minVersion: "TLSv1.2",
      },

      // Timeouts claros (si hay bloqueo/red, falla rápido y deja rastro)
      connectionTimeout: 15000,
      greetingTimeout: 15000,
      socketTimeout: 20000,
    });

    // Verificación no bloqueante (no tumba servidor)
    this.verify().catch(() => {});
  }

  isConfigured() {
    return Boolean(this.transporter);
  }

  async verify() {
    if (!this.transporter) return { ok: false, error: "not_configured" };

    try {
      await this.transporter.verify();
      this.lastVerify = { ok: true, at: new Date().toISOString(), error: null };
      logger.info("Email transporter verified", { at: this.lastVerify.at });
      return { ok: true };
    } catch (error) {
      const details = {
        message: error?.message,
        code: error?.code,
        command: error?.command,
        errno: error?.errno,
        syscall: error?.syscall,
        address: error?.address,
        port: error?.port,
        response: error?.response,
        responseCode: error?.responseCode,
      };

      this.lastVerify = {
        ok: false,
        at: new Date().toISOString(),
        error: details,
      };

      logger.warn("Email transporter verification failed", details);
      return { ok: false, error: details };
    }
  }

  // Construye HTML seguro
  buildContactHtml({ nombre, email, telefono, mensaje }) {
    return `
      <h3>Mensaje desde formulario web</h3>
      <p><b>Nombre:</b> ${escapeHtml(String(nombre))}</p>
      <p><b>Email:</b> ${escapeHtml(String(email))}</p>
      ${telefono ? `<p><b>Teléfono:</b> ${escapeHtml(String(telefono))}</p>` : ""}
      <hr/>
      <p>${escapeHtml(String(mensaje)).replace(/\n/g, "<br/>")}</p>
    `;
  }

  async sendContactEmail({ nombre, email, asunto, mensaje, telefono = "" }) {
    if (!this.transporter) {
      throw new Error("Mail service not configured");
    }

    if (!nombre || !email || !mensaje) {
      throw new Error("Campos requeridos: nombre, email, mensaje");
    }

    if (!validateEmail(email)) {
      throw new Error("Email inválido");
    }

    // From fijo del dominio (mejor entregabilidad), Reply-To el usuario
    const from = config.email.from;
    const to = config.email.to;

    const subject = asunto
      ? `Contacto web - ${asunto}`
      : "Contacto web - Nuevo mensaje";

    const text = [
      `${nombre} (${email})`,
      telefono ? `Teléfono: ${telefono}` : null,
      "",
      String(mensaje),
    ]
      .filter(Boolean)
      .join("\n");

    const html = this.buildContactHtml({ nombre, email, telefono, mensaje });

    try {
      const info = await this.transporter.sendMail({
        from: `"FARES Web" <${from}>`,
        to,
        replyTo: email,
        subject,
        text,
        html,

        // Opcional: ayuda a clasificar / rastrear
        headers: {
          "X-FARES-Form": "contact",
        },
      });

      logger.info("Contact email sent successfully", {
        messageId: info.messageId,
        accepted: info.accepted,
        rejected: info.rejected,
      });

      return { ok: true, messageId: info.messageId };
    } catch (error) {
      logger.error("Failed to send contact email", {
        message: error?.message,
        code: error?.code,
        command: error?.command,
        response: error?.response,
        responseCode: error?.responseCode,
      });
      throw new Error("Error enviando correo");
    }
  }
}

export const emailService = new EmailService();
