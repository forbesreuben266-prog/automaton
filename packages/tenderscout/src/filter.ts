/**
 * Relevance filter for commercial cleaning companies.
 * Uses CPV codes (official classification on each notice) + title keywords.
 */

// CPV prefixes for commercial-cleaning work.
const INCLUDE_CPV = [
  "90900",    // 90900000 Cleaning and sanitation services
  "90910",    // Cleaning services
  "90911",    // Accommodation, building and window cleaning
  "90914",    // Car park cleaning
  "90917",    // Cleaning of transport equipment
  "90919",    // Office, school and office equipment cleaning
  "90920",    // Facility-related sanitation services
  "98341130", // Janitorial services
];
// Cleaning-adjacent but specialist / goods (blast, tank, chimney, bins, pest control, street sweeping, products).
const EXCLUDE_CPV = ["90912", "90913", "90915", "90916", "90918", "90921", "90922", "90923", "90924", "9061", "39830"];
// Facilities-management CPVs where cleaning is often bundled (needs explicit cleaning wording).
const FM_CPV = ["79993", "98341"];

const TITLE_INCLUDE = /\b(clean(ing|ers?)|janitorial|window[- ]clean\w*|deep[- ]clean\w*|washroom|housekeeping|hygiene services|domestic services)\b/i;
const TITLE_EXCLUDE = /\b(cleaning (products|materials|supplies|chemicals|equipment|machines?)|consumables|drain\w*|gull(y|ies)|sewer\w*|street cleans\w*|road sweep\w*|pest|chimney|tank cleaning|dry cleaning|laundry|vehicle wash\w*|beach|litter pick\w*|graffiti|ductwork|kitchen extract|data cleans\w*|data clean\w*)\b/i;
const DESC_STRONG = /\b(cleaning services|cleaning contract|commercial cleaning|office cleaning|school cleaning|window cleaning|janitorial)\b/i;

const startsWithAny = (code: string, list: string[]) => list.some((p) => code.startsWith(p));

export interface RelevanceInput { title: string; description: string; cpv: string[] }

export function isCleaningRelevant({ title, description, cpv }: RelevanceInput): boolean {
  if (TITLE_EXCLUDE.test(title)) return false;
  const included = cpv.some((c) => startsWithAny(c, INCLUDE_CPV));
  const onlyExcluded = cpv.length > 0 && cpv.every((c) => startsWithAny(c, EXCLUDE_CPV));
  if (included) return true;
  if (TITLE_INCLUDE.test(title) && !onlyExcluded) return true;
  if (cpv.some((c) => startsWithAny(c, FM_CPV)) && DESC_STRONG.test(description)) return true;
  return false;
}

const CLOSED = new Set(["cancelled", "unsuccessful", "complete", "withdrawn"]);

export function isOpen(status: string, deadline: string | null, now = new Date()): boolean {
  if (CLOSED.has(status)) return false;
  if (deadline && new Date(deadline).getTime() <= now.getTime()) return false;
  return true;
}
