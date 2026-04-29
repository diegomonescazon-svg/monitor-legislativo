const axios = require('axios');
const cheerio = require('cheerio');

const BASE_URL = 'https://www.senado.gob.ar';
const REUNIONES_URL = `${BASE_URL}/parlamentario/comisiones/verReuniones/`;
const NOVEDADES_RSS_URL = `${BASE_URL}/rss/novedades.xml`;
const PARLAMENTARIA_URL = `${BASE_URL}/parlamentario/parlamentaria/`;

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (compatible; MonitorLegislativo/1.0)',
  'Accept': 'text/html,application/xhtml+xml,application/xml,application/rss+xml,*/*',
  'Accept-Language': 'es-AR,es;q=0.9',
};

function slugify(texto) {
  return texto.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '').slice(0, 60);
}

function parsearFechaArg(texto) {
  // Acepta "dd/mm/yyyy", "dd-mm-yyyy" o strings ISO
  if (!texto) return '';
  const m = texto.match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  try { return new Date(texto).toISOString().split('T')[0]; } catch (_) { return texto; }
}

// --- 1. Proyectos de parlamentaria (fuente original, mejorada) ---
async function fetchParlamentaria() {
  const items = [];
  try {
    const { data } = await axios.get(PARLAMENTARIA_URL, { headers: HEADERS, timeout: 15000 });
    const $ = cheerio.load(data);

    $('table tbody tr').each((_, row) => {
      const celdas = $(row).find('td');
      if (celdas.length < 3) return;

      const linkEl = $(celdas[0]).find('a');
      const href = linkEl.attr('href') || '';
      const url = href.startsWith('http') ? href : href ? `${BASE_URL}${href}` : null;
      const expediente = $(celdas[0]).text().trim().replace(/\s+/g, '-');
      if (!expediente) return;

      items.push({
        external_id: `senado-parl-${expediente}`,
        titulo: $(celdas[1]).text().trim() || `Expediente ${expediente}`,
        tipo: $(celdas[2]).text().trim() || 'Proyecto',
        estado: $(celdas[3])?.text().trim() || 'En trámite',
        camara: 'Senado',
        fecha_ingreso: parsearFechaArg($(celdas[4])?.text().trim()),
        autores: $(celdas[5])?.text().trim() || '',
        url,
      });
    });
  } catch (err) {
    console.warn('[Senado] Error en parlamentaria:', err.message);
  }
  return items;
}

// --- 2. Reuniones de comisiones ---
async function fetchReuniones() {
  const items = [];
  try {
    const { data } = await axios.get(REUNIONES_URL, { headers: HEADERS, timeout: 15000 });
    const $ = cheerio.load(data);

    // El sitio lista reuniones en tabla o tarjetas; intentamos ambos selectores
    const filas = $('table tbody tr').toArray();
    const tarjetas = $('.reunion-item, .card-reunion, article.reunion').toArray();

    const procesar = (el, esTabla) => {
      if (esTabla) {
        const celdas = $(el).find('td');
        if (celdas.length < 2) return;

        const comision = $(celdas[0]).text().trim();
        const fecha = parsearFechaArg($(celdas[1]).text().trim());
        const hora = $(celdas[2])?.text().trim() || '';
        const lugar = $(celdas[3])?.text().trim() || '';
        const href = $(el).find('a').first().attr('href') || '';
        const url = href.startsWith('http') ? href : href ? `${BASE_URL}${href}` : REUNIONES_URL;

        if (!comision) return;
        items.push({
          external_id: `senado-reunion-${slugify(comision)}-${fecha}`,
          titulo: `Reunión de comisión: ${comision}`,
          tipo: 'Reunión de Comisión',
          estado: hora ? `${fecha} ${hora}` : fecha,
          camara: 'Senado',
          fecha_ingreso: fecha,
          autores: lugar || '',
          url,
        });
      } else {
        const titulo = $(el).find('h2,h3,.titulo').first().text().trim();
        const fecha = parsearFechaArg($(el).find('.fecha, time').first().text().trim());
        const href = $(el).find('a').first().attr('href') || '';
        const url = href.startsWith('http') ? href : href ? `${BASE_URL}${href}` : REUNIONES_URL;

        if (!titulo) return;
        items.push({
          external_id: `senado-reunion-${slugify(titulo)}-${fecha}`,
          titulo,
          tipo: 'Reunión de Comisión',
          estado: 'Convocada',
          camara: 'Senado',
          fecha_ingreso: fecha,
          autores: '',
          url,
        });
      }
    };

    filas.forEach(el => procesar(el, true));
    tarjetas.forEach(el => procesar(el, false));

    // Fallback: si la página no tiene tabla ni tarjetas conocidas,
    // extraer cualquier link que parezca una reunión
    if (items.length === 0) {
      $('a[href*="reunion"], a[href*="comision"]').each((_, a) => {
        const titulo = $(a).text().trim();
        const href = $(a).attr('href') || '';
        const url = href.startsWith('http') ? href : `${BASE_URL}${href}`;
        if (!titulo || titulo.length < 5) return;
        items.push({
          external_id: `senado-reunion-${slugify(titulo)}`,
          titulo,
          tipo: 'Reunión de Comisión',
          estado: 'Ver convocatoria',
          camara: 'Senado',
          fecha_ingreso: '',
          autores: '',
          url,
        });
      });
    }
  } catch (err) {
    console.warn('[Senado] Error en reuniones de comisiones:', err.message);
  }
  return items;
}

// --- 3. RSS de novedades legislativas ---
async function fetchRSS() {
  const items = [];
  try {
    const { data } = await axios.get(NOVEDADES_RSS_URL, { headers: HEADERS, timeout: 15000 });
    const $ = cheerio.load(data, { xmlMode: true });

    $('item').each((_, el) => {
      const titulo = $('title', el).text().trim();
      const link = $('link', el).text().trim() || $('guid', el).text().trim();
      const description = $('description', el).text().replace(/<[^>]+>/g, '').trim();
      const pubDate = $('pubDate', el).text().trim();
      const categoria = $('category', el).text().trim();

      if (!titulo) return;

      let fecha = '';
      if (pubDate) {
        try { fecha = new Date(pubDate).toISOString().split('T')[0]; } catch (_) {}
      }

      items.push({
        external_id: `senado-rss-${slugify(titulo)}-${fecha}`,
        titulo,
        tipo: categoria || 'Novedad Legislativa',
        estado: 'Publicado',
        camara: 'Senado',
        fecha_ingreso: fecha,
        autores: '',
        url: link || BASE_URL,
        texto_preview: description.slice(0, 500),
      });
    });
  } catch (err) {
    console.warn('[Senado] Error en RSS de novedades:', err.message);
  }
  return items;
}

// --- Función principal ---
async function fetchProyectosRecientes() {
  console.log('[Senado] Consultando fuentes...');

  const [parlamentaria, reuniones, rss] = await Promise.allSettled([
    fetchParlamentaria(),
    fetchReuniones(),
    fetchRSS(),
  ]);

  const pItems = parlamentaria.status === 'fulfilled' ? parlamentaria.value : [];
  const rItems = reuniones.status === 'fulfilled' ? reuniones.value : [];
  const nItems = rss.status === 'fulfilled' ? rss.value : [];

  // Deduplicar por external_id
  const vistas = new Set();
  const todos = [...pItems, ...rItems, ...nItems].filter(item => {
    if (vistas.has(item.external_id)) return false;
    vistas.add(item.external_id);
    return true;
  });

  console.log(`[Senado] ${pItems.length} parlamentaria + ${rItems.length} reuniones + ${nItems.length} RSS → ${todos.length} únicos`);
  return todos;
}

module.exports = { fetchProyectosRecientes, fuente: 'senado' };
