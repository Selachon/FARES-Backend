// Servicio para gestión de envío de correos electrónicos usando API Brevo v3
// Brevo (antes Sendinblue) provee API REST moderna más robusta que SMTP tradicional
import { config } from "./config.js";
import { logger, validateEmail, escapeHtml } from "./utils.js";

class EmailService {
  constructor() {
    // Almacena estado de la última verificación para debugging
    this.lastVerify = { ok: false, at: null, error: null };
  }

  // Verifica si el servicio está correctamente configurado
  // Requiere API key de Brevo y direcciones de correo válidas
  isConfigured() {
    return Boolean(
      config?.email?.brevoApiKey &&  // API key de Brevo (obligatoria)
      config?.email?.from &&          // Email del remitente (obligatorio)
      config?.email?.to              // Email del destinatario (obligatorio)
    );
  }

  // Verifica la configuración del servicio
  // A diferencia de SMTP, la API REST no necesita conexión persistente
  async verify() {
    // Verificación ligera: solo confirma que tenemos lo necesario
    // (Brevo API no tiene un "verify connection" como SMTP tradicional)
    const ok = this.isConfigured();
    
    // Registra timestamp y estado de verificación
    this.lastVerify = {
      ok,
      at: new Date().toISOString(),
      error: ok ? null : "Missing BREVO_API_KEY / EMAIL_FROM / EMAIL_TO",
    };

    // Registra resultado en logs para monitoreo
    if (!ok) {
      logger.warn("Brevo email service not configured", this.lastVerify);
    } else {
      logger.info("Brevo email service configured", { at: this.lastVerify.at });
    }
    
    return { ok, error: ok ? null : this.lastVerify.error };
  }

  // Construye HTML del correo de contacto con seguridad XSS
  // Formato limpio y profesional para formulario web
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

  // Envía correo de contacto usando API REST v3 de Brevo
  async sendContactEmail({ nombre, email, asunto, mensaje, telefono = "" }) {
    // Verifica que el servicio esté configurado
    if (!this.isConfigured()) {
      throw new Error("Mail service not configured");
    }

    // Validaciones de campos requeridos para el formulario
    if (!nombre || !email || !mensaje) {
      throw new Error("Campos requeridos: nombre, email, mensaje");
    }

    // Valida formato del email del remitente
    if (!validateEmail(email)) {
      throw new Error("Email inválido");
    }

    // Construye asunto del correo (con tema personalizado o por defecto)
    const subject = asunto ? `Contacto web - ${asunto}` : "Contacto web - Nuevo mensaje";

    // Construye versión texto plano del correo (para clientes que no soportan HTML)
    const text = [
      `${nombre} (${email})`,                      // Nombre y email de contacto
      telefono ? `Teléfono: ${telefono}` : null,  // Teléfono opcional
      "",                                         // Línea en blanco
      String(mensaje),                             // Mensaje principal
    ]
      .filter(Boolean)                              // Elimina valores nulos
      .join("\n");                                // Une con saltos de línea

    // Construye versión HTML del correo
    const html = this.buildContactHtml({ nombre, email, telefono, mensaje });

    // Construye payload para API REST v3 de Brevo (envío de correo transaccional)
    const payload = {
      sender: { 
        name: "FARES Web",                    // Nombre del remitente
        email: config.email.from                 // Email del remitente
      },
      to: [{ email: config.email.to }],        // Destinatario del correo
      replyTo: { email },                      // Responder al usuario que contactó
      subject,                                 // Asunto del correo
      textContent: text,                        // Versión texto plano
      htmlContent: html,                        // Versión HTML
      headers: {
        "X-FARES-Form": "contact",             // Header personalizado para tracking
      },
    };

    try {
      // Realiza petición HTTP POST a API v3 de Brevo
      const resp = await fetch("https://api.brevo.com/v3/smtp/email", {
        method: "POST",
        headers: {
          "api-key": config.email.brevoApiKey,    // Autenticación con API key
          "content-type": "application/json",         // Tipo de contenido
          accept: "application/json",                // Acepta respuesta JSON
        },
        body: JSON.stringify(payload),               // Convierte payload a JSON
      });

      // Parsea respuesta JSON, falla gracefully si no es JSON
      const data = await resp.json().catch(() => ({}));

      // Verifica si la API aceptó la solicitud
      if (!resp.ok) {
        logger.error("Brevo send failed", {
          status: resp.status,    // Código HTTP de error
          data,                 // Respuesta de error de Brevo
        });
        throw new Error("Error enviando correo");
      }

      // Registra envío exitoso con ID del mensaje para tracking
      logger.info("Brevo email sent", { messageId: data?.messageId });
      
      return { 
        ok: true, 
        messageId: data?.messageId || null // ID único del mensaje para referencia
      };
    } catch (err) {
      // Maneja errores de red, API o parseo
      logger.error("Brevo send exception", { 
        message: err?.message,
        stack: err?.stack
      });
      throw new Error("Error enviando correo");
    }
  }
}

// Exporta instancia única del servicio (singleton pattern)
// Esto asegura una sola instancia compartida en toda la aplicación
export const emailService = new EmailService();
