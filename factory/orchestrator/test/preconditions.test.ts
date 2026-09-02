import { describe, expect, it } from 'vitest';
import { apiKeyPresent, commandOnPath } from '../src/preconditions.js';

// The two local questions the factory is allowed to ask about a provider
// before it spends a call on one: is the binary runnable, and is the key set.
// They were inside judgePreflight until `enabled: auto` needed the same
// answers at parse time, and two copies of "is codex installed" that could
// disagree is the failure this module exists to make impossible.
describe('provider preconditions', () => {
  it('finds a command that is on PATH and misses one that is not', () => {
    // `sh` is POSIX and on PATH on every box this suite runs on, CI included.
    expect(commandOnPath('sh')).toBe(true);
    expect(commandOnPath('smith-no-such-binary-6f3a1c')).toBe(false);
  });

  it('reads a path-shaped command as a path, never as a name to look up', () => {
    // A command containing a slash is a location, so PATH must not rescue it:
    // `./tools/judge` missing is missing even when a `judge` exists on PATH.
    expect(commandOnPath('/bin/sh')).toBe(true);
    expect(commandOnPath('/bin/smith-no-such-binary-6f3a1c')).toBe(false);
    expect(commandOnPath('./smith-no-such-binary-6f3a1c')).toBe(false);
  });

  it('treats an unset and an empty key as equally absent', () => {
    // An exported-but-empty variable is the shape a half-finished `.envrc`
    // leaves behind, and it buys exactly as many API calls as no variable.
    const name = 'SMITH_TEST_PRECONDITION_KEY';
    delete process.env[name];
    expect(apiKeyPresent(name)).toBe(false);
    process.env[name] = '';
    expect(apiKeyPresent(name)).toBe(false);
    process.env[name] = 'sk-not-a-real-key';
    expect(apiKeyPresent(name)).toBe(true);
    delete process.env[name];
  });
});
