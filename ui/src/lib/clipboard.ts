// DS4 S5c §4 — shared clipboard helper. EpicBlock's "Copy epic id" is the
// first caller; the Kanban board is expected to reuse this later rather than
// duplicating the try/catch.
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
