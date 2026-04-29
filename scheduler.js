require('dotenv').config();
const cron       = require('node-cron');
const nodemailer = require('nodemailer');

const { ejecutarMonitoreo }           = require('./src/processor/analyzer');
const { saveRun, getItemsByRunId }    = require('./src/db/database');
const { SCHEDULE }                    = require('./src/config');

const hcdn           = require('./src/fetchers/hcdn');
const senado         = require('./src/fetchers/senado');
const diputados      = require('./src/fetchers/diputados');
const boletinOficial = require('./src/fetchers/boletin-oficial');

const FETCHERS = [hcdn, senado, diputados, boletinOficial];

// ---------------------------------------------------------------------------
// Logging con timestamp
// ---------------------------------------------------------------------------

function ts() {
  return new Date().toLocaleString('es-AR', {
    timeZone: 'America/Argentina/Buenos_Aires',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

function log(msg)  { console.log(`[${ts()}] ${msg}`); }
function warn(msg) { console.warn(`[${ts()}] ⚠  ${msg}`); }
function err(msg)  { console.error(`[${ts()}] ✖  ${msg}`); }

// ---------------------------------------------------------------------------
// Email
// ---------------------------------------------------------------------------

function crearTransporter() {
  return nodemailer.createTransport({
    host:   process.env.EMAIL_HOST || 'smtp.gmail.com',
    port:   parseInt(process.env.EMAIL_PORT || '587', 10),
    secure: false,
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASS,
    },
  });
}

function formatearItemAlta(item) {
  return [
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
    `📋 ${item.titulo}`,
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
    `📡 Fuente: ${item.fuente}  |  📅 ${item.fecha_publicacion || 'sin fecha'}`,
    `🔑 Keywords: ${item.keywords_encontradas || '—'}`,
    ``,
    `📝 Resumen: ${item.resumen || '—'}`,
    `💡 Impacto: ${item.impacto || '—'}`,
    item.url ? `🔗 ${item.url}` : '',
  ].filter(l => l !== undefined).join('\n');
}

async function enviarEmailAlerta(itemsAltos, resumenRun) {
  if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
    warn('Credenciales de email no configuradas — alerta omitida.');
    return;
  }

  const fecha = new Date().toLocaleDateString('es-AR', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    timeZone: 'America/Argentina/Buenos_Aires',
  });

  const encabezado = [
    `MONITOR LEGISLATIVO — ${fecha}`,
    ``,
    `Resumen del ciclo:`,
    ...resumenRun.map(r =>
      `  • ${r.fuente}: ${r.total_raw} raw → ${r.total_filtrados} filtrados → ${r.total_relevantes} relevantes`
    ),
    ``,
    `─────────────────────────────────────────`,
    `${itemsAltos.length} ITEM(S) DE RELEVANCIA ALTA`,
    `─────────────────────────────────────────`,
    ``,
  ].join('\n');

  const cuerpo = encabezado + itemsAltos.map(formatearItemAlta).join('\n\n');

  try {
    const transporter = crearTransporter();
    await transporter.sendMail({
      from:    `Monitor Legislativo <${process.env.EMAIL_USER}>`,
      to:      process.env.EMAIL_TO || process.env.EMAIL_USER,
      subject: `🛢️ Monitor Legislativo — ${itemsAltos.length} alerta(s) alta relevancia — ${fecha}`,
      text:    cuerpo,
    });
    log(`Email enviado a ${process.env.EMAIL_TO || process.env.EMAIL_USER} (${itemsAltos.length} items)`);
  } catch (e) {
    err(`Error enviando email: ${e.message}`);
  }
}

// ---------------------------------------------------------------------------
// Ciclo principal
// ---------------------------------------------------------------------------

async function ejecutarCiclo() {
  log('══════════════════════════════════════════');
  log('Iniciando ciclo de monitoreo');
  log('══════════════════════════════════════════');

  const inicio = Date.now();

  // 1. Ejecutar todos los fetchers + análisis en paralelo
  log(`Lanzando ${FETCHERS.length} fetchers en paralelo...`);
  const resultados = await Promise.all(
    FETCHERS.map(fetcher =>
      ejecutarMonitoreo(fetcher).catch(e => {
        err(`Fetcher "${fetcher.fuente}" falló: ${e.message}`);
        return {
          fuente: fetcher.fuente,
          total_raw: 0, total_filtrados: 0, total_relevantes: 0,
          items: [], ejecutado_at: new Date().toISOString(), error: e.message,
        };
      })
    )
  );

  // 2. Guardar en DB
  let runId = null;
  try {
    const { runId: id } = saveRun(resultados);
    runId = id;
    log(`Run #${runId} guardado en DB`);
  } catch (e) {
    err(`Error guardando en DB: ${e.message}`);
  }

  // 3. Log de resultados por fuente
  log('─── Resultados por fuente ────────────────');
  for (const r of resultados) {
    const estado = r.error ? `ERROR: ${r.error}` : `${r.total_relevantes} alta(s)`;
    log(`  ${r.fuente.padEnd(20)} raw=${r.total_raw}  filtrados=${r.total_filtrados}  relevantes=${r.total_relevantes}  [${estado}]`);
  }

  // 4. Recopilar items de relevancia alta
  let itemsAltos = [];
  if (runId !== null) {
    try {
      itemsAltos = getItemsByRunId(runId).filter(i => i.relevancia === 'alta');
    } catch (e) {
      err(`Error leyendo items del run: ${e.message}`);
    }
  } else {
    // Fallback: tomar directo de los resultados en memoria
    itemsAltos = resultados
      .flatMap(r => r.items || [])
      .filter(i => i.relevancia === 'alta');
  }

  // 5. Email si hay alertas altas
  if (itemsAltos.length > 0) {
    log(`${itemsAltos.length} item(s) de relevancia alta — enviando alerta...`);
    await enviarEmailAlerta(itemsAltos, resultados);
  } else {
    log('Sin items de relevancia alta — no se envía email.');
  }

  // 6. Resumen final
  const totalFiltrados  = resultados.reduce((s, r) => s + r.total_filtrados, 0);
  const totalRelevantes = resultados.reduce((s, r) => s + r.total_relevantes, 0);
  const duracion = ((Date.now() - inicio) / 1000).toFixed(1);

  log('══════════════════════════════════════════');
  log(`Ciclo completado en ${duracion}s`);
  log(`Total: ${totalFiltrados} filtrados  |  ${totalRelevantes} relevantes  |  ${itemsAltos.length} alertas altas`);
  log('══════════════════════════════════════════\n');
}

// ---------------------------------------------------------------------------
// Arranque
// ---------------------------------------------------------------------------

const runNow = process.argv.includes('--run-now');

if (runNow) {
  log('Modo --run-now: ejecutando ciclo inmediatamente...');
  ejecutarCiclo()
    .then(() => process.exit(0))
    .catch(e => { err(e.message); process.exit(1); });
} else {
  log(`Scheduler activo. Cron: "${SCHEDULE}" (America/Argentina/Buenos_Aires)`);
  log('Usá --run-now para ejecutar manualmente.\n');

  cron.schedule(SCHEDULE, () => {
    ejecutarCiclo().catch(e => err(`Ciclo fallido: ${e.message}`));
  }, { timezone: 'America/Argentina/Buenos_Aires' });

  // Levanta el servidor API en el mismo proceso
  require('./src/api/server');
}
