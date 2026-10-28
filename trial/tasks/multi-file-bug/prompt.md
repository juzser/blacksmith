Two things are wrong in the notes application.

1. Asking for notes by tag, `GET /api/notes?tag=<tag id>`, returns every note
   instead of only the notes that carry that tag.
2. Deleting a tag through the API leaves its links to notes behind in the
   database. After a tag is deleted, no link row that refers to it may remain.

Find the causes and fix them. Do not change the behaviour of anything else.
