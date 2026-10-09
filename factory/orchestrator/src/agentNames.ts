/**
 * The one place a role becomes a Claude Code subagent name, a template file
 * name, and back. The role (`coder`) is data everywhere else: events,
 * policies, ledgers, env names. Only the subagent carries the `bs-` prefix,
 * so that it cannot collide with another plugin's or a user's `coder`.
 */

export const AGENT_PREFIX = 'bs-';

/** `coder` -> `bs-coder`: what `subagent_type` and a template's `name:` carry. */
export function agentNameFor(role: string): string {
  return `${AGENT_PREFIX}${role}`;
}

/** `coder` -> `bs-coder.md`: the template file under `.claude/agents/`. */
export function templateFileFor(role: string): string {
  return `${agentNameFor(role)}.md`;
}

/** `bs-coder.md` -> `coder`; null for a file that is not a `bs-<role>.md` template. */
export function roleOfTemplateFile(file: string): string | null {
  if (!file.endsWith('.md')) return null;
  return roleOfAgentType(file.slice(0, -'.md'.length), { bareAccepted: false });
}

/**
 * What Claude Code puts in a hook's `agent_type` or a dispatch's
 * `subagent_type` -> the role. Strips an optional `<namespace>:` and then the
 * `bs-` prefix. For one transition the bare pre-prefix name (`reviewer`,
 * `blacksmith:reviewer`) is accepted too, because a newer CLI can run with an
 * older plugin still installed. Returns a *candidate* role, not a verified one:
 * any other non-empty name (`general-purpose`) comes back as itself, so the
 * caller must check the result against its own role set. Null only for an
 * empty name, a bare `bs-` or `<ns>:`, or (with `bareAccepted: false`) a name
 * without the prefix.
 */
export function roleOfAgentType(
  agentType: string,
  options: { bareAccepted?: boolean } = {},
): string | null {
  const colon = agentType.lastIndexOf(':');
  const name = colon === -1 ? agentType : agentType.slice(colon + 1);
  if (name.startsWith(AGENT_PREFIX)) {
    const role = name.slice(AGENT_PREFIX.length);
    return role.length > 0 ? role : null;
  }
  if (options.bareAccepted === false) return null;
  return name.length > 0 ? name : null;
}
