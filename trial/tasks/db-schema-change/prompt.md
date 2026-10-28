Let notes be pinned.

- Add a new numbered migration that gives the notes table a `pinned` column: an
  integer, not null, default 0. Existing notes keep their data and start
  unpinned. Do not edit the migrations that already exist.
- Notes in API responses carry `pinned`. The create and update endpoints accept
  an optional `pinned` flag (true or false); when it is left out on create the
  note is not pinned.
- The notes listing returns pinned notes first, then the rest, each group in
  creation order.

Keep the existing behaviour otherwise.
