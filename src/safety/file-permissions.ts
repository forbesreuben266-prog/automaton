/**
 * Secret-file permission checks.
 *
 * automaton.json (provider API keys), config.json (Conway API key) and
 * wallet.json (private key) must not be accessible to, or replaceable by,
 * other users.
 *
 * POSIX (Linux, macOS, other Unix), each existing secret file must:
 * - be a regular file, not a symlink (which could point at a shared file);
 * - grant no permission bits to group or others (mode & 0o077 == 0);
 * - be owned by the current user or by root (another user could change it).
 * Its directory must be owned by the current user or root and must not be
 * writable by group or others (otherwise the file could be swapped).
 *
 * Windows: POSIX mode bits don't describe NTFS ACLs, and this code does not
 * inspect ACLs. Startup therefore REFUSES on Windows unless the operator
 * sets AUTOMATON_ACCEPT_UNVERIFIED_SECRET_PERMISSIONS=1, acknowledging that
 * the files were restricted manually; a warning is logged either way.
 */

import fs from "fs";
import path from "path";

export const SECRET_FILE_NAMES = ["automaton.json", "config.json", "wallet.json"] as const;
export const WINDOWS_ACK_ENV = "AUTOMATON_ACCEPT_UNVERIFIED_SECRET_PERMISSIONS";

export interface PermissionCheckResult {
  /** False when this platform's protections could not be verified. */
  supported: boolean;
  problems: string[];
  warnings: string[];
}

export interface PermissionCheckOptions {
  platform?: NodeJS.Platform;
  /** Current user id (POSIX). Defaults to process.getuid(); null = unavailable. */
  getuid?: (() => number) | null;
  env?: Record<string, string | undefined>;
}

const modeString = (mode: number) => (mode & 0o777).toString(8).padStart(3, "0");

export function checkSecretFilePermissions(
  files: string[],
  options: PermissionCheckOptions = {},
): PermissionCheckResult {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;

  if (platform === "win32") {
    const warning =
      "Secret-file permissions are NOT verified on Windows: POSIX mode bits do not reflect NTFS ACLs and ACLs are not inspected. " +
      "Restrict these files to your user manually: " + files.join(", ");
    if (env[WINDOWS_ACK_ENV] === "1") {
      return { supported: false, problems: [], warnings: [warning] };
    }
    return {
      supported: false,
      problems: [`${warning}. Then set ${WINDOWS_ACK_ENV}=1 to acknowledge and start.`],
      warnings: [],
    };
  }

  const getuid =
    options.getuid === null
      ? undefined
      : options.getuid ?? (typeof process.getuid === "function" ? () => process.getuid!() : undefined);
  if (!getuid) {
    return { supported: false, problems: ["Cannot determine the current user id to verify secret-file ownership"], warnings: [] };
  }
  const uid = getuid();
  const trustedOwner = (owner: number) => owner === uid || owner === 0;

  const problems: string[] = [];
  const checkedDirs = new Set<string>();
  for (const file of files) {
    let stats: fs.Stats;
    try {
      stats = fs.lstatSync(file);
    } catch (err: any) {
      if (err?.code === "ENOENT") continue; // not present: nothing to protect
      problems.push(`${file}: cannot be checked (${err?.code ?? err?.message ?? err})`);
      continue;
    }
    if (stats.isSymbolicLink()) {
      problems.push(`${file} is a symlink; secret files must be regular files`);
      continue;
    }
    if (!stats.isFile()) {
      problems.push(`${file} is not a regular file`);
      continue;
    }
    if ((stats.mode & 0o077) !== 0) {
      problems.push(`${file} has mode ${modeString(stats.mode)}, which gives group/other users access; run: chmod 600 ${file}`);
    }
    if (!trustedOwner(stats.uid)) {
      problems.push(`${file} is owned by uid ${stats.uid}, not the current user (uid ${uid}) or root`);
    }

    const dir = path.dirname(file);
    if (checkedDirs.has(dir)) continue;
    checkedDirs.add(dir);
    try {
      const dirStats = fs.statSync(dir);
      if ((dirStats.mode & 0o022) !== 0) {
        problems.push(`${dir} has mode ${modeString(dirStats.mode)}, so group/other users could replace secret files; run: chmod 700 ${dir}`);
      }
      if (!trustedOwner(dirStats.uid)) {
        problems.push(`${dir} is owned by uid ${dirStats.uid}, not the current user (uid ${uid}) or root`);
      }
    } catch (err: any) {
      problems.push(`${dir}: cannot be checked (${err?.code ?? err?.message ?? err})`);
    }
  }
  return { supported: true, problems, warnings: [] };
}

export function secretFilePaths(automatonDir: string): string[] {
  return SECRET_FILE_NAMES.map((name) => path.join(automatonDir, name));
}
