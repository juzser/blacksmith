Add a search endpoint to the notes API.

`GET /api/notes/search?q=<term>` answers 200 with a JSON list of the notes whose
title or body contains the term, ignoring letter case. Each note in the list has
the same shape as in the existing notes listing, tags included. When `q` is
missing or empty, answer 400 with a JSON body that has an `error` message.

Keep the existing endpoints working as they do now.
