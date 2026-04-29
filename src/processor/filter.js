const { upsertProyecto, actualizarAnalisis, logFetch } = require('../db/proyectos');
const { analizarProyecto } = require('./analyzer');

async function procesarFuente(fetcher) {
  console.log(`[Filter] Procesando fuente: ${fetcher.fuente}`);
  let nuevos = 0;
  let actualizados = 0;

  try {
    const proyectos = await fetcher.fetchProyectosRecientes();
    console.log(`[Filter] ${proyectos.length} proyectos obtenidos de ${fetcher.fuente}`);

    for (const proyecto of proyectos) {
      const { id, nuevo } = upsertProyecto(proyecto);

      if (nuevo) {
        nuevos++;
        const analisis = await analizarProyecto(proyecto);
        actualizarAnalisis(id, analisis);
        console.log(`[Filter] Nuevo: "${proyecto.titulo.slice(0, 60)}..." relevante=${analisis.relevante}`);
      } else {
        actualizados++;
      }

      // Pausa para evitar rate limiting
      await new Promise(r => setTimeout(r, 500));
    }
  } catch (err) {
    console.error(`[Filter] Error en fuente ${fetcher.fuente}:`, err.message);
    logFetch({ fuente: fetcher.fuente, error: err.message });
    return;
  }

  logFetch({ fuente: fetcher.fuente, registros_nuevos: nuevos, registros_actualizados: actualizados });
  console.log(`[Filter] ${fetcher.fuente}: ${nuevos} nuevos, ${actualizados} actualizados`);
}

module.exports = { procesarFuente };
