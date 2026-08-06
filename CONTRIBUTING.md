# Contributing

The short version: this is meant to stay small. A feature that two people watching a film together
wouldn't notice is a feature this app probably shouldn't have.

## Getting it running

Needs Node 22.12+ (Electron 43 requires it).

```bash
npm install
npm run server:dev &   # local signalling on ws://127.0.0.1:8787/ws
npm run dev
```

Two instances on one machine is how you test a call — `--user-data-dir` opts out of the
single-instance lock, which is what the test suites do.

## Before opening a pull request

```bash
npm run typecheck
npm run build && npm test
```

The suites drive **real Electron windows** over the Chrome DevTools Protocol rather than mocking
anything, so they're slow and they occasionally catch things unit tests can't — a window that
renders but lays out at zero height, an overlay that leaks into a screen share. If you add
behaviour a person can see, add a check that reads its **laid-out geometry**, not just that an
element exists. Several checks in here exist because an earlier version of them passed while
testing nothing.

`npm run test:clean` kills anything an interrupted run left behind.

## House style

- Comments explain **why**, not what. If a line looks strange, the comment should say what goes
  wrong without it — ideally with the symptom a user would see.
- **Verify claims about platform behaviour** before writing them down. Several comments in this
  repo were confidently wrong about Chromium and Electron and had to be corrected. The shipped
  `node_modules/electron/electron.d.ts` `@platform` tags are the authority for what works where.
- Don't state things about other projects or products. Describe the mechanism instead.
- No dependencies without a good reason. The whole UI is Preact and hand-written CSS on purpose.

## Things that would genuinely help

- Testing on **Windows and Linux hardware**. Both are implemented and code-reviewed, neither has
  run on a real machine — see `docs/LIMITATIONS.md`.
- A short verification phrase derived from the pair secret, to close the first-contact MITM gap.
- A PipeWire helper for Linux so one application's audio can be captured without capturing Cozy.
