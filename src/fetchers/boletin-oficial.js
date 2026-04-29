const axios = require('axios');
const cheerio = require('cheerio');
const { KEYWORDS } = require('../config');

const BASE_URL = 'https://www.boletinoficial.gob.ar';
const RSS_URL = 'https://www.boletinoficial.gob.ar/rss';
const SEARCH_URL = 'https://www.boletinoficial.gob.ar/norma/resultadosBusqueda';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (compatible; MonitorLegislativo/1.0)',
  'Accept': 'application/json, text/html, application/rss+xml, */*',
};

function fechaHoy() {
  const hoy = new Date();
  const dd = String(hoy.getDate()).padStart(2, '0');
  const mm = String(hoy.getMonth() + 1).padStart(2, '0');
  const yyyy = hoy.getFullYear();
  return { iso: `${yyyy}-${mm}-${dd}`, arg: `${dd}/${mm}/${yyyy}` };
}

function deduplicar(items) {
  const vistas = new Set();
  return items.filter(item => {
    const key = item.url || item.titulo;
    if (vistas.has(key)) return false;
    vistas.add(key);
    return true;
  });
}

function contieneKeyword(texto) {
  const lower = texto.toLowerCase();
  return KEYWORDS.some(kw => lower.includes(kw.toLowerCase()));
}

// --- Búsqueda por palabra clave via endpoint de resultados ---
async function fetchPorBusqueda(fecha) {
  const resultados = [];

  for (const keyword of KEYWORDS) {
    try {
      const { data } = await axios.get(SEARCH_URL, {
        params: {
          q: keyword,
          fechaDesde: fecha.arg,
          fechaHasta: fecha.arg,
          categoria: '',
          pageSize: 20,
          page: 1,
        },
        headers: HEADERS,
        timeout: 15000,
      });

      // El endpoint puede devolver JSON o HTML según el servidor
      let normas = [];
      if (typeof data === 'object' && Array.isArray(data.normas)) {
        normas = data.normas;
      } else if (typeof data === 'object' && Array.isArray(data.results)) {
        normas = data.results;
      } else if (typeof data === 'string') {
        // Respuesta HTML: parsear con cheerio
        const $ = cheerio.load(data);
        $('article, .resultado-item, .norma-item, tr[data-id]').each((_, el) => {
          const tituloEl = $(el).find('h2, h3, .titulo, td.titulo a').first();
          const titulo = tituloEl.text().trim();
          const href = tituloEl.find('a').attr('href') || $(el).find('a').first().attr('href');
          const preview = $(el).find('p, .descripcion, .resumen').first().text().trim();

          if (titulo) {
            normas.push({ titulo, href, resumen: preview });
          }
        });
      }

      for (const norma of normas) {
        const titulo = norma.titulo || norma.denominacion || norma.nombre || '';
        const href = norma.href || norma.url || norma.link || '';
        const preview = norma.resumen || norma.descripcion || norma.sumario || '';
        const url = href.startsWith('http') ? href : `${BASE_URL}${href}`;

        if (!titulo) continue;

        resultados.push({
          titulo: titulo.trim(),
          url,
          fecha: fecha.iso,
          texto_preview: preview.trim().slice(0, 500),
          fuente: 'Boletín Oficial',
          keyword_match: keyword,
        });
      }

      // Pausa entre keywords para no saturar el servidor
      await new Promise(r => setTimeout(r, 800));
    } catch (err) {
      console.warn(`[BO] Error buscando "${keyword}":`, err.message);
    }
  }

  return resultados;
}

// --- Parseo del feed RSS general ---
async function fetchRSS() {
  const resultados = [];

  try {
    const { data } = await axios.get(RSS_URL, {
      headers: { ...HEADERS, Accept: 'application/rss+xml, application/xml, text/xml' },
      timeout: 15000,
    });

    const $ = cheerio.load(data, { xmlMode: true });

    $('item').each((_, item) => {
      const titulo = $('title', item).text().trim();
      const link = $('link', item).text().trim() || $('guid', item).text().trim();
      const description = $('description', item).text().trim();
      const pubDate = $('pubDate', item).text().trim();

      // Filtrar solo los ítems que contienen alguna keyword
      const textoCompleto = `${titulo} ${description}`;
      if (!contieneKeyword(textoCompleto)) return;

      let fechaIso = fechaHoy().iso;
      if (pubDate) {
        try {
          fechaIso = new Date(pubDate).toISOString().split('T')[0];
        } catch (_) {}
      }

      resultados.push({
        titulo: titulo || 'Sin título',
        url: link || BASE_URL,
        fecha: fechaIso,
        texto_preview: description.replace(/<[^>]+>/g, '').trim().slice(0, 500),
        fuente: 'Boletín Oficial',
        keyword_match: KEYWORDS.find(kw => textoCompleto.toLowerCase().includes(kw.toLowerCase())),
      });
    });
  } catch (err) {
    console.warn('[BO] Error leyendo RSS:', err.message);
  }

  return resultados;
}

// --- Función principal exportada ---
async function fetchProyectosRecientes() {
  const fecha = fechaHoy();
  console.log(`[BO] Buscando publicaciones del ${fecha.arg}...`);

  const [porBusqueda, porRss] = await Promise.allSettled([
    fetchPorBusqueda(fecha),
    fetchRSS(),
  ]);

  const busquedaItems = porBusqueda.status === 'fulfilled' ? porBusqueda.value : [];
  const rssItems = porRss.status === 'fulfilled' ? porRss.value : [];

  const todos = deduplicar([...busquedaItems, ...rssItems]);

  console.log(`[BO] ${busquedaItems.length} por búsqueda + ${rssItems.length} por RSS → ${todos.length} únicos`);
  return todos;
}

module.exports = { fetchProyectosRecientes, fuente: 'boletin-oficial' };
