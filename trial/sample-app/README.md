# Trial sample app

A small notes application. It exists only as a fixture: the comparison trial
starts each run from this repository, so it is deliberately generic and
dependency-free.

## What is in it

- An HTTP JSON API built on the Node standard library, with two resources:
  notes and tags (a note can carry tags).
- SQLite storage through the built-in sqlite module, with numbered SQL files
  in the migrations directory and a small runner that applies the ones not yet
  recorded.
- A static front end in the public directory (plain HTML, CSS and JavaScript)
  that calls the API.
- Tests written with the built-in test runner.

The code lives under src: routes hold the HTTP handlers, repos hold the SQL,
and the remaining modules cover the server, static files, migrations and
database access.

## Run it

Needs Node 22.13 or newer. There is nothing to install.

    npm start

The app listens on port 3000 (override with the PORT environment variable) and
keeps its data in a sample-app.db file (override with DB_PATH). Open the
printed address in a browser for the front end.

## Test it

    npm test

The tests use an in-memory database and an ephemeral port.

## API

- GET, POST /api/notes and GET, PUT, DELETE /api/notes/:id
  (GET /api/notes accepts a tag query parameter holding a tag id)
- GET, POST /api/tags and DELETE /api/tags/:id
