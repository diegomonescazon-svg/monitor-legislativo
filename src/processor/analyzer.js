require('dotenv').config();
const Anthropic = require('@anthropic-ai/sdk');
const { KEYWORDS } = require('../config');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// claude-sonnet-4-6 es el alias actual de Claude Sonnet 4.6 (reemplaza al deprecado claude-sonnet-4-20250514)
const MODEL = 'claude-sonnet-4-6';

const SYSTEM_PROMPT =
  'Sos un analista del sector petrolero y de hidrocarburos en Argentina. ' +
  'Respondé siempre con un objeto JSON válido, sin texto adicional antes ni después.';

// --- Filtrado por keywords ---

function keywordsEncontradas(item) {
  const haystack = [item.titulo, item.texto_preview, item.autores, item.tipo]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  return KEYWORDS.filter(kw => haystack.includes(kw.toLowerCase()));
}

function contienKeyword(item) {
  return keywordsEncontradas(item).length > 0;
}

// --- Llamada a Claude ---

async function analizarItem(item) {
  const kwEncontradas = keywordsEncontradas(item);

  const userPrompt =
    `Analizá este item del Boletín Oficial / Congreso:\n` +
    `TÍTULO: ${item.titulo}\n` +
    `TEXTO: ${item.texto_preview || '(sin texto previo)'}\n\n` +
    `Respondé en JSON con exactamente estas claves:\n` +
    `{\n` +
    `  "relevancia": "alta|media|baja",\n` +
    `  "resumen": "2 oraciones máximo",\n` +
    `  "impacto": "qué significa para el sector",\n` +
    `  "keywords_encontradas": []\n` +
    `}`;

  try {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 512,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userPrompt }],
    });

    const text = response.content.find(b => b.type === 'text')?.text || '';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('Respuesta sin JSON válido');

    const parsed = JSON.parse(jsonMatch[0]);

    // Siempre completar keywords_encontradas con las detectadas localmente
    parsed.keywords_encontradas = [
      ...new Set([...(parsed.keywords_encontradas || []), ...kwEncontradas]),
    ];

    return {
      texto_resumen: parsed.resumen || item.titulo,
      analisis_ia: JSON.stringify(parsed),
      relevante: parsed.relevancia === 'alta',
      relevancia: parsed.relevancia || 'baja',
    };
  } catch (err) {
    console.error(`[Analyzer] Error en "${item.titulo.slice(0, 60)}":`, err.message);
    return {
      texto_resumen: item.titulo,
      analisis_ia: JSON.stringify({ error: err.message, keywords_encontradas: kwEncontradas }),
      relevante: false,
      relevancia: 'baja',
    };
  }
}

// --- MonitoringResult ---

/**
 * @typedef {Object} MonitoringResult
 * @property {string}   fuente          - Identificador de la fuente (e.g. "senado")
 * @property {number}   total_raw       - Items devueltos por el fetcher antes de filtrar
 * @property {number}   total_filtrados - Items que contienen al menos una keyword
 * @property {number}   total_relevantes - Items con relevancia "alta" según Claude
 * @property {Array}    items           - Items analizados, con campos de análisis IA adjuntos
 * @property {string}   ejecutado_at    - ISO timestamp del ciclo
 * @property {string|null} error        - Mensaje de error si el ciclo falló completamente
 */

/**
 * Filtra los items del fetcher por keywords, los analiza con Claude
 * y devuelve un MonitoringResult consolidado.
 *
 * @param {Object}   fetcher          - Módulo fetcher con { fetchProyectosRecientes, fuente }
 * @param {Object}   [opciones]
 * @param {number}   [opciones.concurrencia=3] - Llamadas simultáneas a Claude
 * @param {number}   [opciones.pausaMs=400]    - Pausa entre lotes (ms)
 * @returns {Promise<MonitoringResult>}
 */
async function ejecutarMonitoreo(fetcher, { concurrencia = 3, pausaMs = 400 } = {}) {
  const ejecutado_at = new Date().toISOString();

  let rawItems = [];
  try {
    rawItems = await fetcher.fetchProyectosRecientes();
  } catch (err) {
    console.error(`[Analyzer] Fetcher "${fetcher.fuente}" falló:`, err.message);
    return {
      fuente: fetcher.fuente,
      total_raw: 0,
      total_filtrados: 0,
      total_relevantes: 0,
      items: [],
      ejecutado_at,
      error: err.message,
    };
  }

  const filtrados = rawItems.filter(contienKeyword);
  console.log(
    `[Analyzer] ${fetcher.fuente}: ${rawItems.length} raw → ${filtrados.length} con keyword`
  );

  // Procesar en lotes para respetar rate limits
  const analizados = [];
  for (let i = 0; i < filtrados.length; i += concurrencia) {
    const lote = filtrados.slice(i, i + concurrencia);
    const resultados = await Promise.allSettled(lote.map(analizarItem));

    for (let j = 0; j < lote.length; j++) {
      const item = lote[j];
      const r = resultados[j];
      const analisis =
        r.status === 'fulfilled'
          ? r.value
          : { texto_resumen: item.titulo, analisis_ia: '{}', relevante: false, relevancia: 'baja' };

      analizados.push({ ...item, ...analisis });
    }

    if (i + concurrencia < filtrados.length) {
      await new Promise(res => setTimeout(res, pausaMs));
    }
  }

  const relevantes = analizados.filter(i => i.relevante);
  console.log(`[Analyzer] ${fetcher.fuente}: ${relevantes.length} relevantes de ${analizados.length} analizados`);

  return {
    fuente: fetcher.fuente,
    total_raw: rawItems.length,
    total_filtrados: filtrados.length,
    total_relevantes: relevantes.length,
    items: analizados,
    ejecutado_at,
    error: null,
  };
}

// Exportar ambas funciones: la nueva principal y la legacy para filter.js
module.exports = { ejecutarMonitoreo, analizarItem, analizarProyecto: analizarItem };
