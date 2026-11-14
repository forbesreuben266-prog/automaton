/**
 * Deterministic promotional cards: plain typography from the day's approved content (brand, hook, the step taught,
 * product name, link). No product mockups, ratings, results or invented imagery. Same inputs give the same PNG.
 */

import { canvas, encodePng, lineHeight, measure, rect, text, wrap, type Canvas, type RGB } from "./raster.js";

export interface CardInput { readonly brand: string; readonly hook: string; readonly body: string; readonly footer: string; readonly link: string; readonly width: number; readonly height: number }
const NAVY: RGB = [31, 42, 68], CREAM: RGB = [246, 244, 239], WHITE: RGB = [255, 255, 255], INK: RGB = [24, 28, 38], MUTED: RGB = [80, 92, 115], ACCENT: RGB = [196, 140, 60];

export const renderCard = (i: CardInput): Buffer => encodePng(cardCanvas(i));

export function cardCanvas(i: CardInput): Canvas {
  const c = canvas(i.width, i.height, CREAM);
  const m = Math.round(i.width * 0.07), inner = i.width - 2 * m;
  rect(c, 0, 0, i.width, Math.round(i.height * 0.1), NAVY);
  text(c, i.brand, m, Math.round(i.height * 0.1 / 2 - lineHeight("regular") / 2), "regular", WHITE);
  let y = Math.round(i.height * 0.16);
  for (const l of wrap(i.hook, "regular", inner).slice(0, 2)) { text(c, l, m, y, "regular", MUTED); y += lineHeight("regular"); }
  y += Math.round(lineHeight("regular") * 0.6);
  rect(c, m, y, Math.round(inner * 0.18), 8, ACCENT);
  y += 40;
  const maxBodyLines = Math.max(1, Math.floor((i.height * 0.72 - y) / lineHeight("bold")));
  const body = wrap(i.body, "bold", inner);
  const shown = body.length > maxBodyLines ? [...body.slice(0, maxBodyLines - 1), `${body[maxBodyLines - 1]}…`] : body;
  for (const l of shown) { text(c, l, m, y, "bold", INK); y += lineHeight("bold"); }
  const fy = i.height - Math.round(i.height * 0.16);
  rect(c, m, fy - 24, inner, 3, NAVY);
  for (const [k, l] of wrap(i.footer, "regular", inner).slice(0, 2).entries()) text(c, l, m, fy + k * lineHeight("regular"), "regular", INK);
  const link = i.link.replace(/^https:\/\//, "");
  text(c, link, Math.max(m, i.width - m - measure(link, "regular")), i.height - Math.round(i.height * 0.06), "regular", MUTED);
  return c;
}
