/** Desktop actions apply to the machine running the local launcher. */
export function isLocalDesktopHost(hostname: string): boolean {
  return ["localhost", "127.0.0.1", "::1", "[::1]", "::ffff:127.0.0.1"].includes(hostname.toLowerCase());
}
