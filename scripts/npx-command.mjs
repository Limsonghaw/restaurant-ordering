/**
 * Resolve how to invoke `npx` via execFile so the same call works on Windows.
 *
 * On Windows npm ships `npx.cmd`. After CVE-2024-27980, Node refuses to spawn
 * `.cmd` / `.bat` without `shell: true` (it throws EINVAL). `shell` is therefore
 * enabled only on win32. The argument list is a fixed constant; never put the
 * database password or other secrets in argv (pass SQL on stdin instead).
 */
export function npxInvocation(platform = process.platform) {
  const windows = platform === "win32";
  return {
    command: windows ? "npx.cmd" : "npx",
    args: ["supabase", "db", "query", "--local"],
    shell: windows,
  };
}
