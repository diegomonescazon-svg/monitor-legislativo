const KEYWORDS = [
  'petróleo',
  'hidrocarburos',
  'convencional',
  'Vaca Muerta',
  'gas natural',
  'upstream',
  'downstream',
  'YPF',
  'secretaría de energía',
];

const SOURCES = {
  hcdn: {
    name: 'Cámara de Diputados',
    baseUrl: 'https://www.hcdn.gob.ar',
    proyectosUrl: 'https://www.hcdn.gob.ar/proyectos/',
  },
  senado: {
    name: 'Senado de la Nación',
    baseUrl: 'https://www.senado.gob.ar',
    proyectosUrl: 'https://www.senado.gob.ar/parlamentario/parlamentaria/',
  },
};

const SCHEDULE = '0 8 * * 1-5';

module.exports = { KEYWORDS, SOURCES, SCHEDULE };
