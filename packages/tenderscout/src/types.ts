export interface Tender {
  id: string;            // `${source}:${ocid}`
  source: "fts" | "cf";
  ocid: string;
  fingerprint: string;   // cross-platform dedupe key (title + buyer)
  altKey: string | null; // secondary dedupe key (buyer + deadline)
  title: string;
  buyer: string;
  regions: string[];     // region codes from regions.ts; [] = not stated, ["UK"] = UK-wide
  locationLabel: string;
  description: string;
  valueAmount: number | null;
  valueCurrency: string | null;
  deadline: string | null;   // ISO
  deadlineKind: "tender" | "eoi" | null; // tender submission or expression-of-interest deadline
  published: string | null;  // ISO
  url: string;               // official notice URL
  cpv: string[];
  status: string;
}
