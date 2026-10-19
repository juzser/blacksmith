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
- Tests on the built-in test runner.
Code lives under src: routes hold the HTTP handlers, repos hold the SQL.

## Run it

Needs Node 22.13 or newer. There is nothing to install.

    npm start

It listens on port 3000 (PORT overrides) and stores data in sample-app.db
(DB_PATH overrides). Open the printed address in a browser.

## Test it

    npm test

The tests use an in-memory database and an ephemeral port.
