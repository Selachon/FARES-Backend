// src/emailService.js
import { config } from "./config.js";
import { logger, validateEmail, escapeHtml } from "./utils.js";

class EmailService {
  constructor() {
    this.lastVerify = { ok: false, at: null, error: null };
  }

  isConfigured() {
    return Boolean(config?.email?.brevoApiKey && config?.email?.from && config?.email?.to);
  }

  async verify() {
    // Verificación ligera: solo confirma que tenemos lo necesario.
    // (Brevo no tiene un "verify connection" como SMTP)
    const ok = this.isConfigured();
    this.lastVerify = {
      ok,
      at: new Date().toISOString(),
      error: ok ? null : "Missing BREVO_API_KEY / EMAIL_FROM / EMAIL_TO",
    };

    if (!ok) {
      logger.warn("Brevo email service not configured", this.lastVerify);
    } else {
      logger.info("Brevo email service configured", { at: this.lastVerify.at });
    }
    return { ok, error: ok ? null : this.lastVerify.error };
  }

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
    if (!this.isConfigured()) {
      throw new Error("Mail service not configured");
    }

    if (!nombre || !email || !mensaje) {
      throw new Error("Campos requeridos: nombre, email, mensaje");
    }

    if (!validateEmail(email)) {
      throw new Error("Email inválido");
    }

    const subject = asunto ? `Contacto web - ${asunto}` : "Contacto web - Nuevo mensaje";

    const text = [
      `${nombre} (${email})`,
      telefono ? `Teléfono: ${telefono}` : null,
      "",
      String(mensaje),
    ]
      .filter(Boolean)
      .join("\n");

    const html = this.buildContactHtml({ nombre, email, telefono, mensaje });

    // Payload Brevo API v3 (send transactional email)
    const payload = {
      sender: { name: "FARES Web", email: config.email.from },
      to: [{ email: config.email.to }],
      replyTo: { email }, // para responder al usuario
      subject,
      textContent: text,
      htmlContent: html,
      headers: {
        "X-FARES-Form": "contact",
      },
    };

    try {
      const resp = await fetch("https://api.brevo.com/v3/smtp/email", {
        method: "POST",
        headers: {
          "api-key": config.email.brevoApiKey,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify(payload),
      });

      const data = await resp.json().catch(() => ({}));

      if (!resp.ok) {
        logger.error("Brevo send failed", {
          status: resp.status,
          data,
        });
        throw new Error("Error enviando correo");
      }

      logger.info("Brevo email sent", { messageId: data?.messageId });
      return { ok: true, messageId: data?.messageId || null };
    } catch (err) {
      logger.error("Brevo send exception", { message: err?.message });
      throw new Error("Error enviando correo");
    }
  }
}

export const emailService = new EmailService();
