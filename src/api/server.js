require('dotenv').config();
const express = require('express');
const path    = require('path');

const { getRecientes, buscar, getStats } = require('../db/proyectos');
const { getDb, getRunsByDate, getItemsByRunId, getRecentRuns } = require('../db/database');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, '../../public')));

// ---------------------------------------------------------------------------
// Auth middleware — applies only to /api/* routes
// ---------------------------------------------------------------------------

function requireApiKey(req, res, next) {
  const apiKey = process.env.API_KEY;
  if (!apiKey) return next(); // sin API_KEY configurada, acceso abierto

  const provided = req.headers['x-api-key'];
  if (!provided || provided !== apiKey) {
    return res.status(401).json({ ok: false, error: 'API key inválida o ausente' });
  }
  next();
}

app.use('/api', requireApiKey);

// ---------------------------------------------------------------------------
// Proyectos (legacy)
// ---------------------------------------------------------------------------

app.get('/api/proyectos', (req, res) => {
  try {
    const { q, limit } = req.query;
    const data = q ? buscar(q) : getRecientes(parseInt(limit) || 50);
    res.json({ ok: true, data, total: data.length });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/proyectos/:id', (req, res) => {
  try {
    const row = getDb().prepare('SELECT * FROM proyectos WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ ok: false, error: 'No encontrado' });
    res.json({ ok: true, data: row });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ---------------------------------------------------------------------------
// Monitoring runs
// ---------------------------------------------------------------------------

// GET /api/runs?fecha=YYYY-MM-DD   → runs de esa fecha (default: hoy)
app.get('/api/runs', (req, res) => {
  try {
    const fecha = req.query.fecha || new Date().toISOString().split('T')[0];
    const data  = getRunsByDate(fecha);
    res.json({ ok: true, data, fecha });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET /api/runs/recent?dias=30     → últimos N días con conteo de items
app.get('/api/runs/recent', (req, res) => {
  try {
    const dias = parseInt(req.query.dias) || 30;
    const data = getRecentRuns(dias);
    res.json({ ok: true, data });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

// GET /api/items/:runId?relevancia=alta|media|baja
app.get('/api/items/:runId', (req, res) => {
  try {
    const runId = parseInt(req.params.runId);
    if (isNaN(runId)) return res.status(400).json({ ok: false, error: 'runId inválido' });

    let data = getItemsByRunId(runId);

    const { relevancia } = req.query;
    const nivelesValidos = ['alta', 'media', 'baja'];
    if (relevancia) {
      if (!nivelesValidos.includes(relevancia)) {
        return res.status(400).json({
          ok: false,
          error: `relevancia debe ser: ${nivelesValidos.join(', ')}`,
        });
      }
      data = data.filter(i => i.relevancia === relevancia);
    }

    res.json({ ok: true, data, total: data.length });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ---------------------------------------------------------------------------
// Stats históricos
// ---------------------------------------------------------------------------

// GET /api/stats?dias=30
app.get('/api/stats', (req, res) => {
  try {
    const dias = parseInt(req.query.dias) || 30;
    const db   = getDb();

    const intervalo = `-${dias} days`;

    // Resumen global del período
    const resumen = db.prepare(`
      SELECT
        COUNT(DISTINCT r.id)          AS total_runs,
        SUM(r.total_items)            AS total_items,
        SUM(r.items_relevantes)       AS total_relevantes,
        COUNT(DISTINCT date(r.fecha)) AS dias_con_run
      FROM monitoring_runs r
      WHERE r.fecha >= datetime('now', ?)
    `).get(intervalo);

    // Items por nivel de relevancia
    const porRelevancia = db.prepare(`
      SELECT i.relevancia, COUNT(*) AS cantidad
      FROM monitoring_items i
      JOIN monitoring_runs r ON r.id = i.run_id
      WHERE r.fecha >= datetime('now', ?)
      GROUP BY i.relevancia
    `).all(intervalo);

    // Items por fuente
    const porFuente = db.prepare(`
      SELECT i.fuente, COUNT(*) AS cantidad,
             SUM(CASE WHEN i.relevancia = 'alta' THEN 1 ELSE 0 END) AS altas
      FROM monitoring_items i
      JOIN monitoring_runs r ON r.id = i.run_id
      WHERE r.fecha >= datetime('now', ?)
      GROUP BY i.fuente
      ORDER BY cantidad DESC
    `).all(intervalo);

    // Runs por día (para gráficos)
    const porDia = db.prepare(`
      SELECT
        date(r.fecha)        AS dia,
        COUNT(DISTINCT r.id) AS runs,
        SUM(r.total_items)   AS items,
        SUM(r.items_relevantes) AS relevantes
      FROM monitoring_runs r
      WHERE r.fecha >= datetime('now', ?)
      GROUP BY date(r.fecha)
      ORDER BY dia ASC
    `).all(intervalo);

    // Status de runs
    const porStatus = db.prepare(`
      SELECT status, COUNT(*) AS cantidad
      FROM monitoring_runs
      WHERE fecha >= datetime('now', ?)
      GROUP BY status
    `).all(intervalo);

    res.json({
      ok: true,
      dias,
      data: { resumen, porRelevancia, porFuente, porDia, porStatus },
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ---------------------------------------------------------------------------
// Fetch log (legacy)
// ---------------------------------------------------------------------------

app.get('/api/fetch-log', (req, res) => {
  try {
    const data = getDb().prepare(
      'SELECT * FROM fetch_log ORDER BY ejecutado_at DESC LIMIT 50'
    ).all();
    res.json({ ok: true, data });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ---------------------------------------------------------------------------

app.listen(PORT, () => {
  console.log(`[API] http://localhost:${PORT}`);
});

module.exports = app;
