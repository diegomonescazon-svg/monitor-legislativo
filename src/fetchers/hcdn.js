// Fetcher para Honorable Cámara de Diputados de la Nación (HCDN)
const axios = require('axios');
const cheerio = require('cheerio');

const BASE_URL = 'https://www.hcdn.gob.ar';

async function fetchProyectosRecientes() {
  const proyectos = [];

  try {
    const { data } = await axios.get(`${BASE_URL}/proyectos/`, {
      timeout: 15000,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; MonitorLegislativo/1.0)' }
    });

    const $ = cheerio.load(data);

    $('table.table tbody tr').each((_, row) => {
      const celdas = $(row).find('td');
      if (celdas.length < 4) return;

      const linkEl = $(celdas[1]).find('a');
      const url = linkEl.attr('href') ? `${BASE_URL}${linkEl.attr('href')}` : null;
      const external_id = url ? `hcdn-${url.split('/').filter(Boolean).pop()}` : null;

      if (!external_id) return;

      proyectos.push({
        external_id,
        titulo: linkEl.text().trim() || $(celdas[1]).text().trim(),
        tipo: $(celdas[0]).text().trim(),
        estado: $(celdas[3]).text().trim(),
        camara: 'Diputados',
        fecha_ingreso: $(celdas[2]).text().trim(),
        autores: $(celdas[4])?.text().trim() || '',
        url,
      });
    });
  } catch (err) {
    console.error('[HCDN] Error al scrapear:', err.message);
  }

  return proyectos;
}

module.exports = { fetchProyectosRecientes, fuente: 'hcdn' };
