import nodemailer from "nodemailer";
import { config } from "./config.js";
import { logger, validateEmail, escapeHtml } from "./utils.js";

// Servicio para gestión de envío de correos electrónicos
class EmailService {
  constructor() {
    this.transporter = null; // Cliente de transporte de nodemailer
    this.initialize(); // Inicializa servicio al crear instancia
  }

  // Inicializa el servicio de correo con configuración
  initialize() {
    const { email } = config;
    
    // Verifica que las variables requeridas estén configuradas
    if (!email.host || !email.user || !email.pass) {
      logger.warn("Email service not configured - missing environment variables");
      return;
    }

    // Crea transporte de correo con configuración SMTP
    this.transporter = nodemailer.createTransport({
      host: email.host,    // Servidor SMTP
      port: email.port,    // Puerto SMTP
      secure: email.secure, // Usar SSL/TLS
      auth: {
        user: email.user,   // Usuario SMTP
        pass: email.pass,   // Contraseña SMTP
      },
    });

    // Verifica conexión al servidor de correo
    this.verifyConnection();
  }

  // Verifica que la conexión con el servidor SMTP funcione
  async verifyConnection() {
    if (!this.transporter) return;
    
    try {
      await this.transporter.verify(); // Prueba conexión SMTP
      logger.info("Email transporter verified");
    } catch (error) {
      logger.warn("Email transporter verification failed", { error: error.message });
    }
  }

  // Envía correo de contacto desde formulario web
  async sendContactEmail({ nombre, email, asunto, mensaje, telefono = "" }) {
    // Verifica que el servicio esté configurado
    if (!this.transporter) {
      throw new Error("Mail service not configured");
    }

    // Validaciones de campos requeridos
    if (!nombre || !email || !mensaje) {
      throw new Error("Campos requeridos: nombre, email, mensaje");
    }

    // Valida formato del email
    if (!validateEmail(email)) {
      throw new Error("Email inválido");
    }

    // Prepara asunto del correo
    const subject = asunto ? `Contacto web - ${asunto}` : "Contacto web - Nuevo mensaje";
    
    // Construye HTML del correo
    const html = this.buildContactHtml({ nombre, email, telefono, mensaje });

    try {
      // Envía correo usando el transporte configurado
      const info = await this.transporter.sendMail({
        from: `"FARES Web" <${config.email.from}>`, // Remitente
        to: config.email.to,                         // Destinatario
        replyTo: email,                              // Responder a quien envió
        subject,                                     // Asunto
        text: `${nombre} (${email})\n${telefono ? `Teléfono: ${telefono}\n` : ""}${mensaje}`, // Versión texto
        html,                                        // Versión HTML
      });

      logger.info("Contact email sent successfully", { messageId: info.messageId });
      return { ok: true, messageId: info.messageId };
    } catch (error) {
      logger.error("Failed to send contact email", error);
      throw new Error("Error enviando correo");
    }
  }
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

    const subject = asunto ? `Contacto web - ${asunto}` : "Contacto web - Nuevo mensaje";
    const html = this.buildContactHtml({ nombre, email, telefono, mensaje });

    try {
      const info = await this.transporter.sendMail({
        from: `"FARES Web" <${config.email.from}>`,
        to: config.email.to,
        replyTo: email,
        subject,
        text: `${nombre} (${email})\n${telefono ? `Teléfono: ${telefono}\n` : ""}\n${mensaje}`,
        html,
      });

      logger.info("Contact email sent successfully", { messageId: info.messageId });
      return { ok: true, messageId: info.messageId };
    } catch (error) {
      logger.error("Failed to send contact email", error);
      throw new Error("Error enviando correo");
    }
  }

  // Construye HTML del correo de contacto con seguridad XSS
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

  // Verifica si el servicio está configurado y listo para usar
  isConfigured() {
    return this.transporter !== null;
  }
}

// Exporta instancia única del servicio (singleton)
export const emailService = new EmailService();