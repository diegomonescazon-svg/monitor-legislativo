const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '../../data');
const DB_PATH  = path.join(DATA_DIR, 'legislativo.db');

let db;

function getDb() {
  if (!db) {
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    initSchema();
  }
  return db;
}

function initSchema() {
  db.exec(`
    -- Tablas originales (se preservan sin cambios)
    CREATE TABLE IF NOT EXISTS proyectos (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      external_id   TEXT UNIQUE,
      titulo        TEXT NOT NULL,
      tipo          TEXT,
      estado        TEXT,
      camara        TEXT,
      fecha_ingreso TEXT,
      autores       TEXT,
      url           TEXT,
      texto_resumen TEXT,
      analisis_ia   TEXT,
      relevante     INTEGER DEFAULT 0,
      notificado    INTEGER DEFAULT 0,
      created_at    TEXT DEFAULT (datetime('now')),
      updated_at    TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS alertas (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      proyecto_id INTEGER,
      tipo        TEXT,
      mensaje     TEXT,
      enviada     INTEGER DEFAULT 0,
      created_at  TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (proyecto_id) REFERENCES proyectos(id)
    );

    CREATE TABLE IF NOT EXISTS fetch_log (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      fuente                TEXT,
      registros_nuevos      INTEGER DEFAULT 0,
      registros_actualizados INTEGER DEFAULT 0,
      error                 TEXT,
      ejecutado_at          TEXT DEFAULT (datetime('now'))
    );

    -- Nuevas tablas del sistema de monitoreo

    CREATE TABLE IF NOT EXISTS monitoring_runs (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      fecha            TEXT NOT NULL,
      total_items      INTEGER NOT NULL DEFAULT 0,
      items_relevantes INTEGER NOT NULL DEFAULT 0,
      status           TEXT NOT NULL DEFAULT 'ok'
        CHECK(status IN ('ok', 'error', 'parcial')),
      created_at       TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS monitoring_items (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id              INTEGER NOT NULL,
      fuente              TEXT NOT NULL,
      titulo              TEXT NOT NULL,
      url                 TEXT,
      fecha_publicacion   TEXT,
      relevancia          TEXT DEFAULT 'baja'
        CHECK(relevancia IN ('alta', 'media', 'baja')),
      resumen             TEXT,
      impacto             TEXT,
      keywords_encontradas TEXT,
      texto_raw           TEXT,
      created_at          TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (run_id) REFERENCES monitoring_runs(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS clients (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      nombre    TEXT NOT NULL,
      email     TEXT NOT NULL UNIQUE,
      activo    INTEGER NOT NULL DEFAULT 1
        CHECK(activo IN (0, 1)),
      created_at TEXT DEFAULT (datetime('now'))
    );

    -- Índices para las consultas más frecuentes
    CREATE INDEX IF NOT EXISTS idx_runs_fecha         ON monitoring_runs(fecha);
    CREATE INDEX IF NOT EXISTS idx_items_run_id       ON monitoring_items(run_id);
    CREATE INDEX IF NOT EXISTS idx_items_relevancia   ON monitoring_items(relevancia);
    CREATE INDEX IF NOT EXISTS idx_items_fuente       ON monitoring_items(fuente);
    CREATE INDEX IF NOT EXISTS idx_clients_activo     ON clients(activo);
  `);
}

// ---------------------------------------------------------------------------
// monitoring_runs
// ---------------------------------------------------------------------------

/**
 * Persiste un MonitoringResult (o array de ellos) como un run unificado.
 * Acepta tanto un objeto único como un array para el caso multi-fuente.
 *
 * @param {Object|Array} results - MonitoringResult o array de MonitoringResult
 * @returns {{ runId: number, itemIds: number[] }}
 */
function saveRun(results) {
  const db = getDb();
  const lista = Array.isArray(results) ? results : [results];

  const totalItems     = lista.reduce((s, r) => s + (r.total_filtrados ?? 0), 0);
  const totalRelevantes = lista.reduce((s, r) => s + (r.total_relevantes ?? 0), 0);
  const hayError       = lista.some(r => r.error);
  const status         = hayError
    ? (totalItems > 0 ? 'parcial' : 'error')
    : 'ok';

  const insertRun = db.prepare(`
    INSERT INTO monitoring_runs (fecha, total_items, items_relevantes, status)
    VALUES (datetime('now'), ?, ?, ?)
  `);

  const insertItem = db.prepare(`
    INSERT INTO monitoring_items
      (run_id, fuente, titulo, url, fecha_publicacion,
       relevancia, resumen, impacto, keywords_encontradas, texto_raw)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const itemIds = [];

  const transaccion = db.transaction(() => {
    const { lastInsertRowid: runId } = insertRun.run(totalItems, totalRelevantes, status);

    for (const result of lista) {
      for (const item of (result.items ?? [])) {
        let analisis = {};
        try { analisis = JSON.parse(item.analisis_ia || '{}'); } catch (_) {}

        const keywords = Array.isArray(analisis.keywords_encontradas)
          ? analisis.keywords_encontradas.join(', ')
          : (item.keyword_match || '');

        const { lastInsertRowid: itemId } = insertItem.run(
          runId,
          result.fuente ?? item.fuente ?? 'desconocida',
          item.titulo,
          item.url ?? null,
          item.fecha_ingreso ?? item.fecha ?? null,
          item.relevancia ?? (item.relevante ? 'alta' : 'baja'),
          item.texto_resumen ?? analisis.resumen ?? null,
          analisis.impacto ?? null,
          keywords || null,
          item.texto_preview ?? null,
        );
        itemIds.push(itemId);
      }
    }

    return runId;
  });

  const runId = transaccion();
  return { runId, itemIds };
}

/**
 * Devuelve los runs cuya fecha coincide con la fecha dada (YYYY-MM-DD).
 * Sin argumento, usa hoy.
 *
 * @param {string} [fecha] - 'YYYY-MM-DD'
 * @returns {Object[]}
 */
function getRunsByDate(fecha) {
  const db = getDb();
  const dia = fecha ?? new Date().toISOString().split('T')[0];
  return db.prepare(`
    SELECT * FROM monitoring_runs
    WHERE date(fecha) = ?
    ORDER BY created_at DESC
  `).all(dia);
}

/**
 * Devuelve todos los items asociados a un run.
 *
 * @param {number} runId
 * @returns {Object[]}
 */
function getItemsByRunId(runId) {
  return getDb().prepare(`
    SELECT * FROM monitoring_items
    WHERE run_id = ?
    ORDER BY relevancia DESC, created_at ASC
  `).all(runId);
}

/**
 * Devuelve los últimos N runs con conteo de items adjunto.
 *
 * @param {number} [dias=30]
 * @returns {Object[]}
 */
function getRecentRuns(dias = 30) {
  return getDb().prepare(`
    SELECT
      r.*,
      COUNT(i.id) AS items_guardados
    FROM monitoring_runs r
    LEFT JOIN monitoring_items i ON i.run_id = r.id
    WHERE r.fecha >= datetime('now', ?)
    GROUP BY r.id
    ORDER BY r.created_at DESC
  `).all(`-${dias} days`);
}

module.exports = {
  getDb,
  saveRun,
  getRunsByDate,
  getItemsByRunId,
  getRecentRuns,
};
