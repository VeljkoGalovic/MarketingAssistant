/**
 * Keyword filter — extension-side copy of scout/src/keywords.ts.
 * ⚠ keep in sync with the scout (PLAN §2 "one shared intent model").
 * Runs BEFORE storage: only matches are stored or surfaced (low volume, high signal).
 */
window.__hotKeywords = [
  { re: /\b(property management software|pms|channel manager)\b/i, weight: 5 },
  { re: /\b(host\s*tools?|airbnb tools?|vacation rental software)\b/i, weight: 5 },
  { re: /\b(pricing tool|dynamic pricing|rate strategy)\b/i, weight: 4 },
  { re: /\b(any (?:app|tool|software)|any recommendations?)\b/i, weight: 3 },
  { re: /\b(spreadsheet)s?\b.*\b(manage|track|sync)/i, weight: 3 },
  { re: /\b(check.?in|check.?out)\b/, weight: 2 },
  { re: /\b(calendar sync|ical)\b/i, weight: 4 },
  { re: /\b(price ?labs?|wheelhouse|beyond)\b/i, weight: 3 },
];

window.__warmKeywords = [
  { re: /\b(airbnb|vrbo|booking\.com)\b/i, weight: 2 },
  { re: /\b(short[- ]term rental|str|vacation rental|guest house|b&b|inn)\b/i, weight: 2 },
  { re: /\b(host|( rental )?owner|property manager)\b/i, weight: 2 },
  { re: /\b(cleaner|cleaning turnover|housekeeping)\b/i, weight: 2 },
  { re: /\b(direct booking|own website|no airbnb fees?)\b/i, weight: 3 },
  { re: /\b(guest screen|review (?:removal|response)|damage deposit)\b/i, weight: 2 },
  { re: /\b(manual double.?book|double.?book)\b/i, weight: 3 },
  { re: /\b(revenue|occupancy|adr)\b/i, weight: 1 },
];

window.__scoreText = function scoreText(title, body) {
  const haystack = `${title}\n${body}`;
  const matched = [];
  let score = 0;
  for (const { re, weight } of window.__hotKeywords) {
    if (re.test(haystack)) {
      score += weight;
      matched.push(re.source.slice(2, 24));
    }
  }
  for (const { re, weight } of window.__warmKeywords) {
    if (re.test(haystack)) {
      score += weight;
      matched.push(re.source.slice(2, 24));
    }
  }
  return { score, matched };
};

window.__SCOUT_THRESHOLD = 4;
