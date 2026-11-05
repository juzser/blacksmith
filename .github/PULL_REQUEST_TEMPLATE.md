<!-- Conventions: CONTRIBUTING.md. Delete a section only by saying why it does not apply. -->

## What changed and why

<!-- One paragraph. Lead with what forced the change, not with the diff. -->

## What I actually ran

<!-- Paste the tail of the run, not a claim about it. A SKIP line is a step that
     proved nothing: name it. -->

```
$ bash scripts/check.sh
...
== PASS ==
```

- [ ] `bash scripts/check.sh` is green on this branch
- [ ] A change to behaviour has a test that failed before it
- [ ] `CHANGELOG.md` has an entry under Unreleased, if the change is user-visible
