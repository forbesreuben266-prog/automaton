/**
 * Brands: a reusable identifier so plans, content, measurements and costs can later be scoped to several businesses.
 * Existing records carry no brand and belong to the default brand; nothing is migrated.
 */

export interface Brand { readonly id: string; readonly name: string }
export const DEFAULT_BRAND: Brand = Object.freeze({ id: "avenor-studio", name: "Avenor Studio" });
export const BRANDS: readonly Brand[] = [DEFAULT_BRAND];
export const brandOf = (r: { readonly brand?: string }): string => r.brand ?? DEFAULT_BRAND.id;
export function brand(id: string = DEFAULT_BRAND.id): Brand {
  const b = BRANDS.find((x) => x.id === id);
  if (!b) throw new Error(`unknown brand ${id} (known: ${BRANDS.map((x) => x.id).join(", ")})`);
  return b;
}
