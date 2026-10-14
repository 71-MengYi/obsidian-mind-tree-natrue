/**
 * Per-platform availability of the local MCP endpoint.
 *
 * The whole subsystem is refused on mobile: the transport needs a TCP listener
 * and Node's HTTP module, neither of which exists in the mobile runtime, and a
 * half-registered service is worse than a clearly absent one. This predicate is
 * the single place that decides, so the settings page, the plugin wiring and
 * the controller cannot drift apart.
 */
export interface McpPlatformFacts {
  /** `!Platform.isMobile` from Obsidian. */
  isDesktop: boolean;
}

export function isMcpSupported(facts: McpPlatformFacts): boolean {
  return facts.isDesktop;
}
