// The dashboard only reads: an operator approves, rejects or edits a lesson
// through `/bs lessons`, never from this page. The page keeps the list and a
// read-only detail Dialog that shows the same LessonCard; a pending lesson
// says so as plain text (its tab), with nothing to press.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SFC = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'pages', 'LessonsPage.vue'),
  'utf8',
);
const TEMPLATE = SFC.slice(SFC.indexOf('<template>'));

describe('LessonsPage.vue — display-only', () => {
  it('imports no lesson write call, action table or confirm', () => {
    expect(SFC).not.toMatch(
      /approveLesson|rejectLesson|editLesson|LessonWriteResult|lessonActions|noveltyNotice/,
    );
    expect(SFC).not.toMatch(/AlertDialog|Textarea|RadioGroup|useToast/);
  });

  it('renders no approve, reject or edit control, in the list or the detail', () => {
    expect(TEMPLATE).not.toMatch(/#footer/);
    expect(TEMPLATE).not.toMatch(/>\s*(Approve|Reject|Edit|Save & approve|Cancel edit)\b/);
    expect(TEMPLATE).not.toMatch(/Approve anyway/);
  });

  it('keeps the list and opens a read-only detail that shows the same LessonCard', () => {
    expect(TEMPLATE).toMatch(/<LessonCard\s+:lesson="lesson"\s+clickable/);
    const dialog = TEMPLATE.slice(TEMPLATE.indexOf('<Dialog'), TEMPLATE.indexOf('</Dialog>'));
    expect(dialog).toMatch(/<LessonCard v-if="viewing" :lesson="viewing" \/>/);
    expect(dialog).not.toMatch(/<Button\b/);
  });

  it('labels the pending tab as a status, not a task', () => {
    expect(SFC).toMatch(/pending: 'Pending review'/);
  });
});
