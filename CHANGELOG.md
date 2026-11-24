# Changelog

## 0.1.0-alpha.42

- README rewritten in plainer language. Same content; no code change.

## 0.1.0-alpha.41

- Verified in CI on Windows, macOS and Linux with Chrome, Firefox and WebKit, Node 20 to 24: every example grade identical.
- `package.json` names the author, repository and issue tracker. The README lists requirements, says mustfail makes no network calls of its own, and says what feedback helps most.
- Example fix: one example test read the table before its rows arrived and flaked on slower runners. No change to mustfail itself.

## 0.1.0-alpha.40

- Code comments and unit-test fixtures no longer name the private suite mustfail was validated on, its test ids or its API operation names. No behaviour change.

## 0.1.0-alpha.39

- **Second look.** The one run each strong or write-gated grade rests on is repeated once. If the two runs disagree, the weaker result counts and a note says what each run did. Found on a test that, with its delete failing, timed out on a toast wait in two runs and failed an assertion in a third. `--no-confirm` skips it.
- **What changed since last time.** With an earlier report in the output folder, the run ends with the tests that got stronger or weaker, and the HTML report shows the previous grade.
- Projects that other projects depend on (login, seeding, teardown) run once per phase, not once per repeat: their repeats all ran up front as extra logins.
- An unproven reason says when the data that broke the test is read by most tests in the run (probably the app's configuration, not the test's data).
- Not done, on purpose: turning traces, videos and screenshots off during fault runs. Both real suites record them only on retry, which mustfail already disables, and one suite has code that reads the video and attachments, so switching them off could make a test fail for a reason that is not the fault.

## 0.1.0-alpha.38

From a full review of the code.

Fixed:
- A `maxFailures` in the config (common for CI) stopped the fault runs after that many failures, leaving the rest of the suite ungraded. It is now off during mustfail's runs, `globalTimeout` scales with the repeat count, and fault runs use `updateSnapshots: 'none'` so they can never write a snapshot. `-u`, `--last-failed` and `--global-timeout` are refused like the other clashing flags.
- A `globalSetup`, `globalTeardown` or snapshot path template named without `./` ('global-setup.ts') no longer fails with "Cannot find module" (broken since the temporary config moved to the output folder in alpha.36).
- Test files or folders with spaces in their names were not counted: "Playwright listed no tests".
- Generated ids that are not numbers or UUIDs (cuid, nanoid, ULID) in a URL path made the endpoint look different on every run, so its fault never applied. They are folded like other ids.
- Errors outside any test (a failing globalSetup, a crashed worker) were swallowed, because mustfail replaces the project's reporters. They are printed now, and a baseline failure is quoted in the test's reason.
- When the fault runs produced nothing (Playwright crashed), every test was graded not measurable without saying why. mustfail now stops with an error.
- "Asset", "Address" and "Settings" counted as saving verbs ("set", "add") when classifying writes. Words are matched whole, in one place instead of four slightly different ones.
- The temporary config is `.cjs`/`.mjs`, so its module type no longer depends on the package.json above the output folder (an ES-module project with `--out` outside the project).
- A listener or attachment error in mustfail's recorder can no longer surface as an error in a test.
- If a future Playwright moves the internal used to tell a test's body from its setup, mustfail now says so and treats the body as unknown, instead of reading every failed run as "broke in setup".
- Result paths use forward slashes on every OS (grade snapshots would not have matched on Windows).
- README: the example output was not what the cart example prints, and the grades table lacked "no data check".

Added:
- A REST `POST` the server answered with `201 Created` counts as a save, so a test that stays green when its create fails is graded weak (before, only paths holding a verb, PUT, PATCH and DELETE did).
- `import ... from 'playwright/test'` is hooked like `@playwright/test`; `mergeExpects()` results are recorded.
- A note when no test used mustfail's `test` object at all (tests built on a package in node_modules).
- HTML report: click a grade to filter, a search box, the failing error under each proof, all eight grades in the legend.
- The output folder gets a `.gitignore`: baseline.json and plan.json hold samples of API responses.
- In a CI log, one progress line every 25 runs instead of one per run.
- e2e case `cart-odd`: the cart example with the setups above, which must grade the same as cart.

## 0.1.0-alpha.37

- `--fail-on <grades>` exits with code 1 when any test gets one of the listed grades, for CI.
- Playwright flags that would break the runs (`--retries`, `--repeat-each`, `--reporter`, `-x`, `--max-failures`, `--ui`, `--debug`, `--list`) are refused with a reason.
- `--version`; `--help` works as the first argument; options that need a value or a number say so.
- Ctrl-C, SIGTERM (a CI timeout) and a closed terminal now reach Playwright straight away: it shuts down its workers and web server, then mustfail removes its temporary config. Before, a SIGTERM waited for the whole phase to finish.
- A clear error when the output folder cannot be written, and a note when most tests fail with no fault at all.
- Windows: path comparisons ignore drive-letter case; helper names are read from files with CRLF line endings.
- Unit tests run on Node 20 (no glob support in `node --test` there). CI workflow for Windows, macOS and Linux, Chrome, Firefox and WebKit, Node 20 to 24, and Playwright 1.50 to 1.65.

## 0.1.0-alpha.36

- Runs that broke in setup before their fault touched anything are no longer graded on. mustfail re-runs the tests that failed just before them with no fault, retries those runs once, warns with the error and the suspects, and grades not measurable where key runs still broke. Found on Strapi, whose rate-limit test leaves rate limiting on when it fails.
- New weak rule: a test that stays green when its own create, update, delete or save returns 500.
- Writes are recorded when sent, so a write whose response arrives after the test body ends is still faulted.
- REST writes are recognised as saves by method and path (PUT, PATCH, DELETE, or a path naming create, update, delete…).
- Playwright runs from the folder mustfail was started in; the temporary config lives in the output folder, with relative paths in your config made absolute, so suites that `git clean` between tests do not delete it.
- `/tokens` endpoints (API tokens, transfer tokens) are no longer treated as login endpoints.

## 0.1.0-alpha.1 to alpha.35

Built and validated against a large private Playwright suite: zero-touch hooking (CommonJS and ES modules), two baseline runs, blackout, targeted change-value, empty-list, change-rows, flip-booleans and failed-write faults, assertion text matching, helper attribution, request checks, leaky-run filtering, and the HTML and console reports.
