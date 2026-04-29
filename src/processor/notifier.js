require('dotenv').config();
const nodemailer = require('nodemailer');
const { getRelevantesNoNotificados, marcarNotificado } = require('../db/proyectos');

function crearTransporter() {
  return nodemailer.createTransport({
    host: process.env.EMAIL_HOST || 'smtp.gmail.com',
    port: parseInt(process.env.EMAIL_PORT || '587'),
    secure: false,
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASS,
    },
  });
}

function formatearProyecto(p) {
  let analisis = {};
  try { analisis = JSON.parse(p.analisis_ia || '{}'); } catch (_) {}

  return `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📋 ${p.titulo}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🏛️  Cámara: ${p.camara} | Tipo: ${p.tipo || 'N/D'} | Estado: ${p.estado || 'N/D'}
📅 Ingresado: ${p.fecha_ingreso || 'N/D'} | Autores: ${p.autores || 'N/D'}
📊 Impacto: ${analisis.impacto || 'N/D'} | Temas: ${(analisis.temas || []).join(', ')}

📝 Resumen:
${p.texto_resumen || 'Sin resumen disponible'}

💡 Análisis IA:
${analisis.justificacion || 'Sin análisis'}

${p.url ? `🔗 Ver más: ${p.url}` : ''}
`;
}

async function enviarAlertas() {
  const proyectos = getRelevantesNoNotificados();

  if (proyectos.length === 0) {
    console.log('[Notifier] No hay proyectos relevantes pendientes de notificación');
    return;
  }

  if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
    console.warn('[Notifier] Credenciales de email no configuradas. Marcando como notificados sin enviar.');
    proyectos.forEach(p => marcarNotificado(p.id));
    return;
  }

  const transporter = crearTransporter();
  const cuerpo = proyectos.map(formatearProyecto).join('\n\n');
  const fecha = new Date().toLocaleDateString('es-AR', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

  const mailOptions = {
    from: `Monitor Legislativo <${process.env.EMAIL_USER}>`,
    to: process.env.EMAIL_TO || process.env.EMAIL_USER,
    subject: `🏛️ Monitor Legislativo — ${proyectos.length} proyecto(s) relevante(s) — ${fecha}`,
    text: `MONITOR LEGISLATIVO\n${fecha}\n\n${proyectos.length} proyecto(s) requieren atención:\n\n${cuerpo}`,
  };

  try {
    await transporter.sendMail(mailOptions);
    proyectos.forEach(p => marcarNotificado(p.id));
    console.log(`[Notifier] Alerta enviada: ${proyectos.length} proyecto(s) a ${mailOptions.to}`);
  } catch (err) {
    console.error('[Notifier] Error enviando email:', err.message);
  }
}

module.exports = { enviarAlertas };
