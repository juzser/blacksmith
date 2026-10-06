// events.ts stamps every write with CLAUDE_CODE_SESSION_ID when it is set,
// and this suite is run from inside Claude Code as often as not: left alone,
// every fixture event -- and every event a spawned server or CLI child
// writes -- would carry the runner's own CLI session, and a test about an
// unstamped log would pass or fail by where it was launched from. Same rule
// as factory/orchestrator/test/setup.ts; cliSessionScrub.test.ts pins it.
delete process.env.CLAUDE_CODE_SESSION_ID;
