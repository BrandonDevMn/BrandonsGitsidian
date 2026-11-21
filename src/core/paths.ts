// Which paths are synced. See specs/01-setup-and-auth.feature "Default exclusions".

export const DEFAULT_EXCLUDES = [".obsidian/", ".trash/", ".git/"];
export const CONFLICT_LOG_PATH = "_brandon-gitsidian/conflict log.md";

/**
 * Patterns:
 * - "dir/"       anything under dir (at the vault root)
 * - "*.tmp"      any file ending in .tmp, in any folder
 * - "private/**" anything under private/
 * - "a/b.md"     exactly that path
 */
export function isExcluded(path: string, patterns: readonly string[]): boolean {
  return patterns.some((p) => matches(path, p.trim()));
}

function matches(path: string, pattern: string): boolean {
  if (!pattern) return false;
  if (pattern.endsWith("/")) return path === pattern.slice(0, -1) || path.startsWith(pattern);
  if (!pattern.includes("*")) return path === pattern;
  const hasSlash = pattern.includes("/");
  const target = hasSlash ? path : path.slice(path.lastIndexOf("/") + 1);
  return globToRegExp(pattern).test(target);
}

function globToRegExp(glob: string): RegExp {
  let re = "^";
  for (let i = 0; i < glob.length; i++) {
    const c = glob.charAt(i);
    if (c === "*") {
      if (glob.charAt(i + 1) === "*") {
        re += ".*";
        i++;
        if (glob.charAt(i + 1) === "/") i++;
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(re + "$");
}

// Characters iOS file names can't hold. See specs/09-limits-and-errors.feature.
const INVALID_ON_IOS = /[:\\]/;

export function isValidOnIos(path: string): boolean {
  return !INVALID_ON_IOS.test(path) && !path.split("/").some((part) => part === "" || part === "." || part === "..");
}
