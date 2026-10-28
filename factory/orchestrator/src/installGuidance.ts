// Operator-facing wording that depends on whether the CLI runs from a clone or
// from an installed package. Pure: the caller (cli.ts) passes IS_CLONE and does
// the writing. The install and plugin lines quote INSTALL.md; a test reads that
// file and fails when they drift.

/** Next-step guidance printed on stderr after `bs init`. */
export function initGuidance(isClone: boolean): string {
  const lines = ['', 'Next steps:'];
  if (!isClone) {
    lines.push(
      '  1. In a Claude Code session, install the plugin:',
      '/plugin marketplace add juzser/blacksmith',
      '/plugin install blacksmith@blacksmith',
      '  2. Check the install: bs doctor',
      '  3. Answer the stack interview (INSTALL.md Step 5) in .blacksmith/factory/policies/stack.yml (under $BS_HOME if you set one), the copy bs init made, then read it back from the project:',
      '     bs stack show',
      '     bs stack check',
      '  4. Start a project: bs new <project>',
    );
  } else {
    lines.push('  1. Check the install: bs doctor', '  2. Start a project: bs new <project>');
  }
  return `${lines.join('\n')}\n`;
}

/** Message of the `ui.not-built` error: what to run when the dashboard server is missing. */
export function uiNotBuiltMessage(serverEntry: string, isClone: boolean): string {
  const base = `ui/server is not built (expected ${serverEntry}).`;
  return isClone
    ? `${base} Run "pnpm build:server" first.`
    : `${base} This install is incomplete; reinstall the package with "npm i -g @juzser/blacksmith".`;
}
