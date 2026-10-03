// DS4 S5c fix round 1, fix 2 — RequestQuote.vue's "Show more" toggle must
// only render when the quote text actually overflows its 3-line clamp
// (ds-review.html ~1300). The decision itself is one comparison; pulled out
// so it is unit-testable without mounting a component or a real layout
// engine (jsdom's scrollHeight/clientHeight are both 0).
export function isTextClamped(scrollHeight: number, clientHeight: number): boolean {
  return scrollHeight > clientHeight;
}
