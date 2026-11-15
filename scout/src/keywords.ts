/**
 * Keyword scoring — the in-daemon counterpart of the in-extension filter (Phase 4).
 * One shared intent model: "property host with an operational pain point".
 *
 * Hot keywords strongly signal buying intent (they are looking for a tool).
 * Warm keywords signal topic relevance. Score = sum of weights per unique match.
 */

const HOT: Array<{ re: RegExp; weight: number }> = [
  { re: /\b(property management software|pms|channel manager)\b/i, weight: 5 },
  { re: /\b(host\s*tools?|airbnb tools?|vacation rental software)\b/i, weight: 5 },
  { re: /\b(pricing tool|dynamic pricing|rate strategy)\b/i, weight: 4 },
  { re: /\b(any (?:app|tool|software)|any recommendations?)\b/i, weight: 3 },
  { re: /\b(spreadsheet)s?\b.*\b(manage|track|sync)/i, weight: 3 },
  { re: /\b(check.?in|check.?out)\b/, weight: 2 },
  { re: /\b(calendar sync|ical)\b/i, weight: 4 },
  { re: /\b(price ?labs?|wheelhouse|beyond)\b/i, weight: 3 },
];

const WARM: Array<{ re: RegExp; weight: number }> = [
  { re: /\b(airbnb|vrbo|booking\.com|stripe)\b/i, weight: 2 },
  { re: /\b(short[- ]term rental|str|vacation rental|guest house|b&b|inn)\b/i, weight: 2 },
  { re: /\b(host|( rental )?owner|property manager)\b/i, weight: 2 },
  { re: /\b(cleaner|cleaning turnover|housekeeping)\b/i, weight: 2 },
  { re: /\b(direct booking|own website|no airbnb fees?)\b/i, weight: 3 },
  { re: /\b(guest screen|review (?:removal|response)|damage deposit)\b/i, weight: 2 },
  { re: /\b(manual double.?book|double.?book)\b/i, weight: 3 },
  { re: /\b(revenue|occupancy|adr)\b/i, weight: 1 },
];

export function scoreText(title: string, body: string): { score: number; matched: string[] } {
  const haystack = `${title}\n${body}`;
  const matched: string[] = [];
  let score = 0;

  for (const { re, weight } of HOT) {
    if (re.test(haystack)) {
      score += weight;
      matched.push(re.source.slice(2, 24));
    }
  }
  for (const { re, weight } of WARM) {
    if (re.test(haystack)) {
      score += weight;
      matched.push(re.source.slice(2, 24));
    }
  }
  return { score, matched };
}
