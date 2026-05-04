// ISO 3166-1 alpha-2 → display name map. One source of truth for the export pipeline.
const ISO_3166_1_ALPHA_2 = {
  AE: 'United Arab Emirates', AF: 'Afghanistan', AL: 'Albania', AM: 'Armenia',
  AO: 'Angola', AR: 'Argentina', AT: 'Austria', AU: 'Australia',
  AZ: 'Azerbaijan', BA: 'Bosnia and Herzegovina', BD: 'Bangladesh', BE: 'Belgium',
  BG: 'Bulgaria', BH: 'Bahrain', BR: 'Brazil', BY: 'Belarus',
  CA: 'Canada', CH: 'Switzerland', CL: 'Chile', CM: 'Cameroon',
  CN: 'China', CO: 'Colombia', CR: 'Costa Rica', CY: 'Cyprus',
  CZ: 'Czechia', DE: 'Germany', DK: 'Denmark', DO: 'Dominican Republic',
  DZ: 'Algeria', EC: 'Ecuador', EE: 'Estonia', EG: 'Egypt',
  ES: 'Spain', ET: 'Ethiopia', FI: 'Finland', FR: 'France',
  GB: 'United Kingdom', GE: 'Georgia', GH: 'Ghana', GR: 'Greece',
  GT: 'Guatemala', HK: 'Hong Kong', HN: 'Honduras', HR: 'Croatia',
  HU: 'Hungary', ID: 'Indonesia', IE: 'Ireland', IL: 'Israel',
  IN: 'India', IQ: 'Iraq', IR: 'Iran', IS: 'Iceland',
  IT: 'Italy', JM: 'Jamaica', JO: 'Jordan', JP: 'Japan',
  KE: 'Kenya', KG: 'Kyrgyzstan', KH: 'Cambodia', KR: 'South Korea',
  KW: 'Kuwait', KZ: 'Kazakhstan', LB: 'Lebanon', LK: 'Sri Lanka',
  LT: 'Lithuania', LU: 'Luxembourg', LV: 'Latvia', LY: 'Libya',
  MA: 'Morocco', MD: 'Moldova', ME: 'Montenegro', MK: 'North Macedonia',
  MN: 'Mongolia', MT: 'Malta', MX: 'Mexico', MY: 'Malaysia',
  NG: 'Nigeria', NL: 'Netherlands', NO: 'Norway', NP: 'Nepal',
  NZ: 'New Zealand', OM: 'Oman', PA: 'Panama', PE: 'Peru',
  PH: 'Philippines', PK: 'Pakistan', PL: 'Poland', PS: 'Palestine',
  PT: 'Portugal', PY: 'Paraguay', QA: 'Qatar', RO: 'Romania',
  RS: 'Serbia', RU: 'Russia', SA: 'Saudi Arabia', SE: 'Sweden',
  SG: 'Singapore', SI: 'Slovenia', SK: 'Slovakia', SN: 'Senegal',
  SY: 'Syria', TH: 'Thailand', TN: 'Tunisia', TR: 'Türkiye',
  TW: 'Taiwan', TZ: 'Tanzania', UA: 'Ukraine', UG: 'Uganda',
  US: 'United States', UY: 'Uruguay', UZ: 'Uzbekistan', VE: 'Venezuela',
  VN: 'Vietnam', YE: 'Yemen', ZA: 'South Africa', ZM: 'Zambia',
  ZW: 'Zimbabwe',
};

function countryName(code) {
  if (!code) return '';
  const upper = String(code).trim().toUpperCase();
  return ISO_3166_1_ALPHA_2[upper] || upper;
}

function countryNames(codes) {
  if (!Array.isArray(codes)) return [];
  return codes.map(countryName).filter(Boolean);
}

module.exports = { countryName, countryNames, ISO_3166_1_ALPHA_2 };
