/** Minimal JSON-lines logger (same structured style as Automaton's observability logger). Never log subscriber emails. */
type Level = "info" | "warn" | "error";
function write(level: Level, msg: string, ctx?: Record<string, unknown>) {
  if (process.env.TS_LOG_SILENT === "1") return;
  const line = JSON.stringify({ ts: new Date().toISOString(), level, module: "tenderscout", msg, ...ctx });
  (level === "error" ? process.stderr : process.stdout).write(line + "\n");
}
export const log = {
  info: (m: string, c?: Record<string, unknown>) => write("info", m, c),
  warn: (m: string, c?: Record<string, unknown>) => write("warn", m, c),
  error: (m: string, c?: Record<string, unknown>) => write("error", m, c),
};
