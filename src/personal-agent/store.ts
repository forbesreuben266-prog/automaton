/** Notes, tasks, conversation history and the audit log, kept as private JSON files in the data folder. */

import { createHash, randomBytes } from "node:crypto";
import path from "node:path";
import { appendPrivate, readPrivate, writePrivate } from "./files.js";
import type { ChatMessage } from "./types.js";

export interface Note { readonly id: string; readonly text: string; readonly tags: readonly string[]; readonly createdAt: string }
export interface Task { readonly id: string; readonly title: string; readonly due: string | null; readonly done: boolean; readonly createdAt: string; readonly doneAt: string | null }

const newId = () => randomBytes(4).toString("hex");
const MAX_ITEMS = 5000;
const MAX_HISTORY = 40;

function load<T>(dir: string, name: string): T[] {
  const t = readPrivate(path.join(dir, name));
  if (t === null) return [];
  const v = JSON.parse(t);
  if (!Array.isArray(v)) throw new Error(`${name}: corrupt (not a list)`);
  return v as T[];
}
const save = (dir: string, name: string, items: unknown[]) => writePrivate(path.join(dir, name), JSON.stringify(items, null, 1) + "\n");

export function addNote(dir: string, text: string, tags: string[], now: Date): Note {
  const notes = load<Note>(dir, "notes.json");
  if (notes.length >= MAX_ITEMS) throw new Error(`notes: the limit of ${MAX_ITEMS} is reached`);
  const n: Note = { id: newId(), text, tags, createdAt: now.toISOString() };
  save(dir, "notes.json", [...notes, n]);
  return n;
}
export function listNotes(dir: string): Note[] { return load<Note>(dir, "notes.json"); }
export function searchNotes(dir: string, query: string): Note[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return listNotes(dir).filter((n) => words.every((w) => n.text.toLowerCase().includes(w) || n.tags.some((t) => t.toLowerCase().includes(w))));
}

export function addTask(dir: string, title: string, due: string | null, now: Date): Task {
  const tasks = load<Task>(dir, "tasks.json");
  if (tasks.length >= MAX_ITEMS) throw new Error(`tasks: the limit of ${MAX_ITEMS} is reached`);
  const t: Task = { id: newId(), title, due, done: false, createdAt: now.toISOString(), doneAt: null };
  save(dir, "tasks.json", [...tasks, t]);
  return t;
}
export function listTasks(dir: string): Task[] { return load<Task>(dir, "tasks.json"); }
export function completeTask(dir: string, id: string, now: Date): Task | null {
  const tasks = load<Task>(dir, "tasks.json");
  const i = tasks.findIndex((t) => t.id === id);
  if (i < 0) return null;
  const t: Task = { ...tasks[i], done: true, doneAt: now.toISOString() };
  tasks[i] = t;
  save(dir, "tasks.json", tasks);
  return t;
}

/** Conversation history: the last MAX_HISTORY messages (user and final assistant text only; no tool traffic). */
export function loadHistory(dir: string): ChatMessage[] {
  return load<ChatMessage>(dir, "history.json").filter((m) => m.role === "user" || m.role === "assistant").slice(-MAX_HISTORY);
}
export function saveHistory(dir: string, messages: readonly ChatMessage[]): void {
  save(dir, "history.json", messages.filter((m) => m.role === "user" || (m.role === "assistant" && !m.toolCalls?.length)).slice(-MAX_HISTORY) as unknown[]);
}
export function clearHistory(dir: string): void { save(dir, "history.json", []); }

/** One JSON line per model call or tool decision. Tool arguments are recorded as a hash plus their size, not verbatim. */
export function audit(dir: string, entry: Record<string, unknown>, now: Date): void {
  appendPrivate(path.join(dir, "audit.jsonl"), JSON.stringify({ at: now.toISOString(), ...entry }));
}
export const digest = (v: unknown) => createHash("sha256").update(JSON.stringify(v) ?? "").digest("hex").slice(0, 16);

/** Paid-provider token use per UTC day. */
export function tokensUsedToday(dir: string, now: Date): number {
  const t = readPrivate(path.join(dir, "usage.json"));
  const u = t === null ? {} : (JSON.parse(t) as Record<string, number>);
  return u[now.toISOString().slice(0, 10)] ?? 0;
}
export function addTokens(dir: string, tokens: number, now: Date): void {
  const t = readPrivate(path.join(dir, "usage.json"));
  const u = t === null ? {} : (JSON.parse(t) as Record<string, number>);
  const day = now.toISOString().slice(0, 10);
  u[day] = (u[day] ?? 0) + tokens;
  writePrivate(path.join(dir, "usage.json"), JSON.stringify(u) + "\n");
}
