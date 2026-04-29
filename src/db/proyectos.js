const { getDb } = require('./database');

function upsertProyecto(proyecto) {
  const db = getDb();
  const existing = db.prepare('SELECT id FROM proyectos WHERE external_id = ?').get(proyecto.external_id);

  if (existing) {
    db.prepare(`
      UPDATE proyectos SET
        titulo = ?, tipo = ?, estado = ?, camara = ?,
        fecha_ingreso = ?, autores = ?, url = ?,
        updated_at = datetime('now')
      WHERE external_id = ?
    `).run(
      proyecto.titulo, proyecto.tipo, proyecto.estado, proyecto.camara,
      proyecto.fecha_ingreso, proyecto.autores, proyecto.url,
      proyecto.external_id
    );
    return { id: existing.id, nuevo: false };
  }

  const result = db.prepare(`
    INSERT INTO proyectos (external_id, titulo, tipo, estado, camara, fecha_ingreso, autores, url)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    proyecto.external_id, proyecto.titulo, proyecto.tipo, proyecto.estado,
    proyecto.camara, proyecto.fecha_ingreso, proyecto.autores, proyecto.url
  );
  return { id: result.lastInsertRowid, nuevo: true };
}

function actualizarAnalisis(id, { texto_resumen, analisis_ia, relevante }) {
  getDb().prepare(`
    UPDATE proyectos SET texto_resumen = ?, analisis_ia = ?, relevante = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(texto_resumen, analisis_ia, relevante ? 1 : 0, id);
}

function marcarNotificado(id) {
  getDb().prepare(`UPDATE proyectos SET notificado = 1 WHERE id = ?`).run(id);
}

function getRelevantesNoNotificados() {
  return getDb().prepare(`
    SELECT * FROM proyectos WHERE relevante = 1 AND notificado = 0 ORDER BY created_at DESC
  `).all();
}

function getRecientes(limit = 50) {
  return getDb().prepare(`
    SELECT * FROM proyectos ORDER BY created_at DESC LIMIT ?
  `).all(limit);
}

function buscar(query) {
  const term = `%${query}%`;
  return getDb().prepare(`
    SELECT * FROM proyectos
    WHERE titulo LIKE ? OR autores LIKE ? OR analisis_ia LIKE ?
    ORDER BY created_at DESC LIMIT 100
  `).all(term, term, term);
}

function getStats() {
  const db = getDb();
  return {
    total: db.prepare('SELECT COUNT(*) as n FROM proyectos').get().n,
    relevantes: db.prepare('SELECT COUNT(*) as n FROM proyectos WHERE relevante = 1').get().n,
    pendientes_notificar: db.prepare('SELECT COUNT(*) as n FROM proyectos WHERE relevante = 1 AND notificado = 0').get().n,
    por_camara: db.prepare('SELECT camara, COUNT(*) as n FROM proyectos GROUP BY camara').all(),
  };
}

function logFetch({ fuente, registros_nuevos, registros_actualizados, error }) {
  getDb().prepare(`
    INSERT INTO fetch_log (fuente, registros_nuevos, registros_actualizados, error)
    VALUES (?, ?, ?, ?)
  `).run(fuente, registros_nuevos || 0, registros_actualizados || 0, error || null);
}

module.exports = { upsertProyecto, actualizarAnalisis, marcarNotificado, getRelevantesNoNotificados, getRecientes, buscar, getStats, logFetch };
