
// Servicio de envío de correos electrónicos
// Utiliza API de Brevo (SendInBlue) para envío de correos transaccionales
import { config } from "./config.js";
import { logger, validateEmail, escapeHtml } from "./utils.js";

class EmailService {
  constructor() {
    // Estado de última verificación de configuración
    this.lastVerify = { ok: false, at: null, error: null };
  }
  
  // Verificar si el servicio de email está correctamente configurado
  isConfigured() {
    return Boolean(
      config?.email?.brevoApiKey &&  // API key de Brevo requerida
      config?.email?.from &&         // Email remitente requerido
      config?.email?.to              // Email destinatario requerido
    );
  }

  async verify() {
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
    const sanitizedNombre = escapeHtml(String(nombre));
    const sanitizedEmail = escapeHtml(String(email));
    const sanitizedTelefono = telefono ? escapeHtml(String(telefono)) : null;
    const sanitizedMensaje = escapeHtml(String(mensaje)).replace(/\n/g, "<br/>");

    return `
      <h3>Mensaje desde formulario web</h3>
      <p><b>Nombre:</b> ${sanitizedNombre}</p>
      <p><b>Email:</b> ${sanitizedEmail}</p>
      ${sanitizedTelefono ? `<p><b>Teléfono:</b> ${sanitizedTelefono}</p>` : ""}
      <hr/>
      <p>${sanitizedMensaje}</p>
    `;
  }

  
  // Enviar correo de contacto desde formulario web
  async sendContactEmail({ nombre, email, asunto, mensaje, telefono = "" }) {
    
    // Verificar que el servicio esté configurado
    if (!this.isConfigured()) {
      throw new Error("Mail service not configured");
    }

    // Validar campos requeridos
    if (!nombre || !email || !mensaje) {
      throw new Error("Campos requeridos: nombre, email, mensaje");
    }

    // Validar formato del email
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

    
    const payload = {
      sender: { 
        name: "FARES Web",
        email: config.email.from
      },
      to: [{ email: config.email.to }],
      replyTo: { email },
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
          "api-key": config.email.brevoApiKey,    // Autenticación con API key
          "content-type": "application/json",         // Tipo de contenido
          accept: "application/json",                // Acepta respuesta JSON
        },
        body: JSON.stringify(payload),               // Convierte payload a JSON
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
      
      return { 
        ok: true, 
        messageId: data?.messageId || null
      };
    } catch (err) {
      
      logger.error("Brevo send exception", { 
        message: err?.message,
        stack: err?.stack
      });
      throw new Error("Error enviando correo");
    }
  }
}


export const emailService = new EmailService();
