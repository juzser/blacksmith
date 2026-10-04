// Fix round item 7: Activity's own "because of your prompt" scroll+highlight
// (ActivityPage.vue) and Home's identical need (HomePage.vue, previously a
// no-op) share this one DOM lookup instead of each page inlining it.
export function scrollToTimelineRow(eventId: string): void {
  const el = document.getElementById(`activity-row-${eventId}`);
  el?.scrollIntoView({ block: 'center' });
}
