The notes data-access module in `src/repos` has grown into one large file.
Refactor it into several smaller modules without changing behaviour.

- Keep the same public functions, importable from the same path as today.
- Move the tag-association code (reading a note's tags and replacing them)
  into a module of its own.
- Afterwards, every JavaScript file under `src/repos` should be at most 50
  lines long, and there should be at least three of them.

Behaviour must stay exactly as it is, and the existing tests must still pass.
