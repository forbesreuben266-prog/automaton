/**
 * FICTIONAL pipeline fixtures, derived from the Phase 0 division's fictional
 * fixtures (reserved example domains, invented organisations). No real
 * research material. The manifest's SHA-256 values are of the fictional
 * snapshot texts.
 */

import { createHash } from "crypto";
import { AS_OF, validReport } from "../business-research/fixtures.js";

export { AS_OF };
export const OPPORTUNITY_ID = "dog-walking";

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

export function validOpportunity(): any {
  const r = validReport();
  return { version: 1, id: OPPORTUNITY_ID, title: r.title, brief: r.brief };
}

export function validManifest(): any {
  const r = validReport();
  return {
    version: 1,
    opportunityId: OPPORTUNITY_ID,
    runDate: AS_OF,
    sources: r.snapshots.map((s: any) => ({
      id: s.id, file: `${s.id}.txt`, sha256: sha256(s.content), url: s.url, publisher: s.publisher, title: s.title,
      publishedAt: s.publishedAt, retrievedAt: s.retrievedAt, originId: s.originId, derivedFromSnapshotIds: s.derivedFromSnapshotIds,
      independenceVerified: s.independenceVerified, independenceNote: s.independenceNote,
    })),
  };
}

export function validWorkbook(): any {
  const r = validReport();
  return {
    version: 1, opportunityId: OPPORTUNITY_ID, reportId: r.id, asOf: AS_OF,
    claims: r.claims, sections: r.sections, assumptions: r.assumptions, scenarios: r.scenarios, scoring: r.scoring, experiments: r.experiments,
  };
}

/** Throws unless fn throws; returns the joined error text. */
export function errorText(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    const e = err as { issues?: string[]; message: string };
    return e.issues ? e.issues.join("\n") : e.message;
  }
  throw new Error("expected a refusal, but parsing succeeded");
}
