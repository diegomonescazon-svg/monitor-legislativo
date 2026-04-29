const axios = require('axios');
const cheerio = require('cheerio');

const BASE_URL = 'https://www.hcdn.gob.ar';
const BUSCADOR_URL = `${BASE_URL}/proyectos/resultados-buscador.html`;

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (compatible; MonitorLegislativo/1.0)',
  'Accept': 'text/html,application/xhtml+xml',
  'Accept-Language': 'es-AR,es;q=0.9',
};

function fechaHoy() {
  const hoy = new Date();
  const dd = String(hoy.getDate()).padStart(2, '0');
  const mm = String(hoy.getMonth() + 1).padStart(2, '0');
  const yyyy = hoy.getFullYear();
  // HCDN acepta formato dd/mm/yyyy en sus filtros de fecha
  return `${dd}/${mm}/${yyyy}`;
}

function normalizarExpediente(texto) {
  // Ejemplos: "0001-D-2025", "1234-S-2024"
  return texto.replace(/\s+/g, '').trim();
}

function extraerFila($, row) {
  const celdas = $(row).find('td');
  if (celdas.length < 3) return null;

  // Estructura habitual del buscador:
  // [0] número/expediente  [1] tipo  [2] título + link  [3] autor(es)  [4] fecha
  const expedienteRaw = $(celdas[0]).text().trim();
  const expediente = normalizarExpediente(expedienteRaw);
  if (!expediente) return null;

  const tipo = $(celdas[1]).text().trim();

  const tituloEl = $(celdas[2]).find('a').first();
  const titulo = tituloEl.text().trim() || $(celdas[2]).text().trim();
  const href = tituloEl.attr('href') || '';
  const url = href.startsWith('http') ? href : href ? `${BASE_URL}${href}` : null;

  // Autor puede estar en columna 3, o inline junto al título en algunos layouts
  const autores = celdas.length > 3 ? $(celdas[3]).text().trim() : '';
  const fecha = celdas.length > 4 ? $(celdas[4]).text().trim() : fechaHoy();

  return {
    external_id: `diputados-${expediente}`,
    titulo: titulo || `Expediente ${expediente}`,
    tipo: tipo || 'Proyecto',
    estado: 'En trámite',
    camara: 'Diputados',
    fecha_ingreso: fecha,
    autores,
    url,
    expediente,
  };
}

async function fetchPagina(pagina, fechaFiltro) {
  const { data } = await axios.get(BUSCADOR_URL, {
    params: {
      fechaDesde: fechaFiltro,
      fechaHasta: fechaFiltro,
      pagina,
    },
    headers: HEADERS,
    timeout: 20000,
  });
  return data;
}

async function fetchProyectosRecientes() {
  const proyectos = [];
  const fecha = fechaHoy();
  console.log(`[Diputados] Buscando proyectos del ${fecha}...`);

  let pagina = 1;
  let hayMas = true;

  while (hayMas) {
    let html;
    try {
      html = await fetchPagina(pagina, fecha);
    } catch (err) {
      console.error(`[Diputados] Error en página ${pagina}:`, err.message);
      break;
    }

    const $ = cheerio.load(html);
    const filas = $('table.table tbody tr, table#proyectos tbody tr, table tbody tr').toArray();

    if (filas.length === 0) {
      // Sin resultados para esta fecha: intentar sin filtro de fecha y tomar los más recientes
      if (pagina === 1) {
        console.warn('[Diputados] Sin resultados con filtro de fecha. Obteniendo recientes sin filtro...');
        try {
          const { data: sinFiltro } = await axios.get(BUSCADOR_URL, { headers: HEADERS, timeout: 20000 });
          const $sf = cheerio.load(sinFiltro);
          $sf('table tbody tr').each((_, row) => {
            const item = extraerFila($sf, row);
            if (item) proyectos.push(item);
          });
        } catch (e) {
          console.error('[Diputados] Error en fallback sin filtro:', e.message);
        }
      }
      break;
    }

    let nuevosEnPagina = 0;
    for (const row of filas) {
      const item = extraerFila($, row);
      if (item) {
        proyectos.push(item);
        nuevosEnPagina++;
      }
    }

    // Verificar si existe botón/link de siguiente página
    const hayPaginaSiguiente =
      $('a[rel="next"], .pagination .next:not(.disabled), a:contains("Siguiente")').length > 0;

    console.log(`[Diputados] Página ${pagina}: ${nuevosEnPagina} proyectos`);

    if (!hayPaginaSiguiente || nuevosEnPagina === 0) {
      hayMas = false;
    } else {
      pagina++;
      // Pausa entre páginas para no saturar el servidor
      await new Promise(r => setTimeout(r, 600));
    }
  }

  console.log(`[Diputados] Total: ${proyectos.length} proyectos encontrados`);
  return proyectos;
}

module.exports = { fetchProyectosRecientes, fuente: 'diputados' };
