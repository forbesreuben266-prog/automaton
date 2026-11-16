/**
 * UK region mapping. Sources express location as NUTS/ITL codes (FTS),
 * region names (Contracts Finder) or postcodes. We normalise to 12 regions.
 */
export const REGIONS: Record<string, string> = {
  NE: "North East",
  NW: "North West",
  YH: "Yorkshire and the Humber",
  EM: "East Midlands",
  WM: "West Midlands",
  EE: "East of England",
  LDN: "London",
  SE: "South East",
  SW: "South West",
  WAL: "Wales",
  SCO: "Scotland",
  NI: "Northern Ireland",
};
export const ENGLAND = ["NE", "NW", "YH", "EM", "WM", "EE", "LDN", "SE", "SW"];

const NUTS1: Record<string, string> = {
  C: "NE", D: "NW", E: "YH", F: "EM", G: "WM", H: "EE", I: "LDN", J: "SE", K: "SW", L: "WAL", M: "SCO", N: "NI",
};

const NAMES: Record<string, string[]> = {
  "north east": ["NE"], "north west": ["NW"], "yorkshire and the humber": ["YH"], "yorkshire and humber": ["YH"],
  "yorkshire": ["YH"], "east midlands": ["EM"], "west midlands": ["WM"], "east of england": ["EE"], "eastern": ["EE"],
  "london": ["LDN"], "greater london": ["LDN"], "south east": ["SE"], "south west": ["SW"], "wales": ["WAL"],
  "scotland": ["SCO"], "northern ireland": ["NI"], "england": ENGLAND, "united kingdom": ["UK"], "uk": ["UK"],
  "any region": ["UK"], "great britain": ["UK"],
};

const POSTCODE_AREAS: Record<string, string> = {};
const add = (r: string, areas: string) => areas.split(" ").forEach((a) => (POSTCODE_AREAS[a] = r));
add("NE", "DH DL NE SR TS");
add("NW", "BB BL CA CH CW FY L LA M OL PR SK WA WN");
add("YH", "BD DN HD HG HU HX LS S WF YO");
add("EM", "DE LE LN NG NN");
add("WM", "B CV DY HR ST TF WR WS WV");
add("EE", "AL CB CM CO EN IP LU NR PE SG SS WD");
add("LDN", "E EC N NW SE SW W WC BR CR HA IG RM SM TW UB");
add("SE", "BN CT DA GU HP KT ME MK OX PO RG RH SL SO TN");
add("SW", "BA BH BS DT EX GL PL SN SP TA TQ TR");
add("WAL", "CF LD LL NP SA SY");
add("SCO", "AB DD DG EH FK G HS IV KA KW KY ML PA PH TD ZE");
add("NI", "BT");

export function regionFromNuts(code: string | undefined): string[] {
  if (!code) return [];
  const c = code.trim().toUpperCase();
  const m = c.match(/^(?:UK|TL)([C-N])/);
  if (m) return [NUTS1[m[1]]];
  if (c === "UK" || c === "TL" || c === "UKZ" || c === "TLZ") return ["UK"];
  return [];
}

export function regionFromName(name: string | undefined): string[] {
  if (!name) return [];
  return NAMES[name.trim().toLowerCase()] ?? [];
}

export function regionFromPostcode(pc: string | undefined): string[] {
  if (!pc) return [];
  const m = pc.trim().toUpperCase().match(/^([A-Z]{1,2})\d/);
  if (!m) return [];
  return POSTCODE_AREAS[m[1]] ? [POSTCODE_AREAS[m[1]]] : [];
}

/** Resolve any location hint (NUTS code, region name, postcode). */
export function resolveRegion(hint: { region?: string; postalCode?: string }): string[] {
  return (
    (regionFromNuts(hint.region).length && regionFromNuts(hint.region)) ||
    (regionFromName(hint.region).length && regionFromName(hint.region)) ||
    regionFromPostcode(hint.postalCode)
  );
}

export function labelRegions(codes: string[]): string {
  if (!codes.length) return "Location not stated";
  if (codes.includes("UK")) return "UK-wide";
  if (ENGLAND.every((c) => codes.includes(c))) return "England-wide";
  return codes.map((c) => REGIONS[c] ?? c).join(", ");
}

/** Does a tender's location match a subscriber's chosen regions? */
export function matchesRegions(tenderRegions: string[], wanted: string[]): boolean {
  if (wanted.includes("ALL")) return true;
  if (!tenderRegions.length || tenderRegions.includes("UK")) return true; // national / unstated: show to everyone
  return tenderRegions.some((r) => wanted.includes(r));
}

export function sanitizeRegions(input: string[]): string[] {
  const valid = input.filter((r) => r === "ALL" || r in REGIONS);
  return valid.length === 0 || valid.includes("ALL") ? ["ALL"] : Array.from(new Set(valid));
}
