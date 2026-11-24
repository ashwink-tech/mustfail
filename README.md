# mustfail

A test that cannot fail is not a test.

`mustfail` finds Playwright tests that stay green when the app is broken. It runs your suite with API responses failed or changed, and reports which tests notice. You do not edit your tests or your config.

```bash
npx mustfail run
```

```
mustfail: 3 decorative · 1 unproven · 3 strong  (of 7 tests)

DECORATIVE — Stays green when the app is broken
  cart.spec.ts:2  cart page loads
      Stayed green with every API call failing (3 calls failed).
      note: Only checks that elements are visible, not what they show.

UNPROVEN — Notices an outage; nothing more could be tested
  cart.spec.ts:6  shows cart items
      Fails when `items` emptied in GET /api/cart, so it needs that data, but none of the
      assertions mustfail could read are tied to its values.

STRONG — An assertion failed when the data was wrong
  cart.spec.ts:15  checkout works
      Failed when POST /api/checkout returned 500.
  merged.spec.ts:3  custom fixture: total shown
      Failed when `total` changed in GET /api/cart.
```

(Shortened output from `examples/cart`.)

An HTML version is written to `.mustfail/report.html`: click a grade to show only its tests, or type to filter by test name or file.

**Requirements:** Node 20 or newer (20.6+ for ES-module projects) and `@playwright/test` 1.50 or newer. No dependencies of its own.

**Nothing leaves your machine.** mustfail makes no network calls of its own: it changes responses on their way from your app to the browser, through Playwright, and writes its report to a local folder.

> **Alpha.** Expect rough edges. Run it against a local or disposable environment: fault runs repeat your tests' requests, including writes that the fault does not target.

## What the grades mean

| Grade | Rule |
| --- | --- |
| **Decorative** | Passed a run where every API call returned 500, or ran no assertion |
| **Weak** | Failed that run, but passed when its own data was changed or its own write failed (a create, update, delete or save returned 500 and nothing it checks noticed) |
| **No data check** | Fails when the page cannot load, but none of its assertions is tied to a server value, and it stayed green when its data was changed or emptied. Fine for browser-only behaviour (form rules, date pickers); a gap if the test is meant to verify data |
| **Strong** | An assertion failed when a value it displays was changed, its list was emptied, the true/false fields in its rows were flipped, or its write failed. Marked "via a helper" when the only assertion that failed sits in a setup helper (`createX`, `waitForX`) rather than the test or a check helper (`expectX`, `verifyX`) |
| **Request check** | Its real check is on the request the page sent (`request.postData()`, `postDataJSON()`), which no server fault can change. Tests with other grades that also check their request say so in their reason |
| **Write-gated** | Stops when its own write fails, but only because a click or wait timed out: it waits for the save, and no assertion checked the result. If that write is only setup, it says little about what the test is for |
| **Unproven** | Needs the data to exist (fails when it is gone), but no assertion mustfail can read is tied to its values, and changing them did not make it fail |
| **Not measurable** | Fails or flakes without faults, is marked `test.fail()` (a known open bug), makes no API calls in the browser, checks data it mocks itself, or makes a request fail itself (mocks a 4xx/5xx), or its key fault runs broke in setup for a reason the fault cannot explain (see below) |

## How it works

1. **Baseline.** Runs your suite twice with no faults. It records each test's API calls, the shape of each JSON response (every response of an endpoint, not only the first, so a list fetched again after the test created a row is included), and the text each passing assertion checked. Tests that fail or flip between the two runs are left out.
2. **Plan.** For each test: one blackout run, then up to three targeted faults (`--max-targeted`), plus probes of the page's main list, one failed write of its own and, where it checks booleans, one flip of them. Targets are chosen by matching the text your assertions checked against response values, so a test that asserts `42.00` gets the response field `total: 42` changed. A value the test created itself (it appears only in a later response and has digits in it, like a generated name) counts as a match even when the assertion only checks that the row is visible.
3. **Fault runs.** All in one Playwright invocation with `--repeat-each`, using your config's workers and projects. Faults are applied with `context.route`. Login and session endpoints are never faulted, and that includes the signed-in user's own record (`/me`, `/users/me`): a test that only shows the user's name or email cannot be proven here.
4. **Retry of broken setups.** A fault run that fails before the test body starts, while its fault has not touched a single request, was not broken by the fault. Usually an earlier test failed partway (as fault runs make it) and skipped cleanup at the end of its body: a setting left on, a rate limit, leftover data. mustfail re-runs the tests that failed just before each such stretch with no fault (their passing run usually undoes it), then retries those runs once. The report warns with the error and the suspects, and tests whose key runs still broke are graded not measurable instead of on what was left. The fix in your suite is to move that cleanup into `afterEach` or a `finally` block, which also protects you when a real bug makes the test fail.
5. **Second look.** Each strong or write-gated grade rests on one run. That run is repeated once; if the two disagree (an assertion failed one time, a wait timed out the other), the weaker result is counted and the test's notes say so. Skip with `--no-confirm`.

When the output folder holds a report from an earlier run, the new one ends with what changed for the tests graded both times (stronger, weaker, other), and the HTML report shows each changed test's previous grade.

It hooks in at load time: `@playwright/test` (and `playwright/test`) imports in your own files resolve to a thin wrapper that adds the fixtures. Playwright runs from the folder you started mustfail in, as `npx playwright test -c <config>` would. Nothing is written to your repo except the output folder (`.mustfail/` by default); the temporary config that wraps yours lives there and is removed at the end.

The wrapped config is yours with a few settings changed for the run: retries off, mustfail's reporter in place of yours, `maxFailures` off (fault runs fail on purpose), projects that others depend on (login, seeding) run once instead of once per repeat, `globalTimeout` multiplied by the number of times each test runs, and `updateSnapshots: 'none'` during fault runs, so a page showing wrong data can never write or replace a snapshot.

The output folder holds `baseline.json` and `plan.json`, which contain samples of what your API returned (names, emails, whatever the app shows). mustfail puts a `.gitignore` in the folder so it stays out of git; treat those two files like test data from that environment. `report.html` and `report.json` hold field names, endpoints and error lines, not response values.

## Options

```
npx mustfail run [options] [-- <extra playwright test args>]

  -c, --config <file>        Playwright config (default: playwright.config.{ts,js,mts,mjs,cjs,cts})
  -o, --out <dir>            Output folder (default: .mustfail)
      --max-targeted <n>     Targeted faults per test after the blackout (default: 3)
      --expect-timeout <ms>  Assertion timeout during fault runs (default: 3x the slowest baseline assertion, min 1500)
      --action-timeout <ms>  Action timeout during fault runs (default: your config's)
      --allow-remote         Allow a baseURL that is not localhost (fault runs repeat real writes)
      --fail-on <grades>     Exit with code 1 if any test gets one of these grades, e.g. decorative,weak
      --no-confirm           Do not repeat the run each strong or write-gated grade rests on
      --yes                  Skip the confirmation prompt
  -h, --help                 Show this help
  -v, --version              Show mustfail's version

  npx mustfail run -- --project=chromium tests/checkout
```

Exit codes: 0 when the run finished (whatever the grades, unless `--fail-on` matched), 1 when `--fail-on` matched or mustfail crashed, 2 for a usage or setup problem (no config, no `@playwright/test`, no tests listed). Ctrl-C or a CI timeout stops Playwright and its web server and removes mustfail's temporary config.

## In CI

Grades are only worth gating on once you have read a first report and agree with it. Then, for example in GitHub Actions:

```yaml
- run: npx mustfail run --yes --fail-on decorative -- --project=chromium
- uses: actions/upload-artifact@v4
  if: always()
  with: { name: mustfail-report, path: .mustfail/report.html }
```

With no terminal there is no prompt; `--yes` makes that explicit. Run it on a schedule or on pull requests that touch tests, not on every push: a full run takes 3 to 4 times your suite's runtime.

## Limits today

- **Only tests that get `test` from your own files are seen.** A `test` object that comes from a package in `node_modules` (a shared fixtures package), a browser context the test creates itself (`browser.newContext()`), and API-only tests are out of reach; they are graded not measurable, and mustfail says so when it saw no test at all.
- **A save is recognised by its shape.** GraphQL mutations by a saving verb in the operation name; REST by PUT, PATCH, DELETE, a saving verb in the path, or a POST the server answered with 201. A create that answers 200 on a plain path (`POST /orders`) is still failed once, but staying green then is not graded weak.
- **ES-module projects need Node 20.6 or newer.** Projects with `"type": "module"` or an `.mjs`/`.mts` config are redirected through a Node loader hook (`module.register`); CommonJS projects use a `--require` hook.
- **Only browser traffic.** Data fetched on the server (Next.js SSR, server components) never reaches the browser, so tests that depend on it show as not measurable. So do API-only tests using `request`, and tests that create their own browser context.
- **Requests cannot be faulted.** A test that asserts what it sent is recognised (graded "request check" or noted), not proven: mustfail changes responses, not what the app sends.
- **Booleans are probed only where there is a sign the test reads them.** A test asserting `toBeChecked`, `toBeEnabled` or `toBeDisabled` gets one extra fault that flips the true/false fields in the rows of a list it reads, when its checked text comes from that list or a boolean in it changed between responses. Booleans outside lists, or in lists with neither sign, are not flipped.
- **Only the first five rows of a list are read** for matching, so a row a test creates far down a long list does not link to its assertion.
- **Strong says an assertion failed, not which one mattered.** When the only assertion that failed sits in a helper whose name has no check verb (`createMetric`, `waitForTile`, not `expectRow` or `verifyTotal`), the grade is marked "strong (via a helper)" and names it: often a page object checking the setup it just did, while the test's own check is a count or a boolean mustfail cannot see. Helpers are told apart by name only.
- **A changed value that breaks a click is not proof.** A test that finds a row by the value mustfail changed stops on the click before any assertion. It is not graded strong, but its reason says the wrong value did stop it.
- **Unproven covers tests that only need the app's own configuration.** When the blackout breaks a test in setup, the next fault that breaks it is often an emptied schema or menu list (`/init`, content-type definitions). The grade stays unproven, and the reason says so when most tests in the run read that call. In a run of one feature's folder the feature's own list is read by most tests too, so the wording is a hint, not a verdict.
- **The suspects in a broken-setup warning are a shortlist.** Tests in one file run back to back, so the one that leaked state and its neighbours look the same; the retry fixes the grades either way.
- **Only the deciding run is repeated.** A test with a race in it can stop at a different step from one run to the next (a wait one time, an assertion the next). The run a strong or write-gated grade rests on is run twice and the weaker result counts; two runs catch such a race often, not always, and runs that decide other grades are run once.
- **Two baseline runs** catch flaky tests only some of the time.
- **Runtime:** about 3 to 4 times your normal suite runtime for a full run. Scope with extra Playwright args.
- **Tested on Playwright 1.50 to 1.65** (1.50, 1.53, 1.56, 1.59, 1.62, 1.65: every example grade identical) and Node 20, 22 and 24, on Linux, macOS and Windows, with Chrome, Firefox and WebKit (every example grade identical in CI), and against two real suites with Chrome/Chromium (a large private suite and Strapi's admin, settings and content-manager e2e tests, 200+ tests).

## How this differs from similar tools

| Tool | Approach | Needs test changes |
| --- | --- | --- |
| **mustfail** | Fails or changes real API responses at runtime and checks whether each test notices | No |
| playwright-mutation-gate | Inverts each test's primary assertion and checks the test goes red | Yes, mark one assertion per test |
| falsegreen, hollowtest, vacuous | Read test source for patterns that cannot fail (no assertion, tautologies) | No, but cannot see runtime behaviour |
| Stryker and other mutation tools | Change application source and run unit tests | No, but unit-level, not end-to-end |

## Development

```
npm test            # unit tests (node:test, no dependencies)
npm run test:e2e    # runs mustfail on examples/tasks, tasks-esm, cart and cart-odd and compares every grade with test/expected/
node test/e2e.js --update        # rewrite the snapshots after an intended change (review the diff)
node test/matrix.js 1.50.1 1.65.1  # the tasks example against other @playwright/test versions
```

The examples need Google Chrome installed (they use `channel: 'chrome'`). `examples/tasks-esm` is generated from `examples/tasks` by the e2e script: edit the tasks app, not the copy. `examples/cart odd` is generated from `examples/cart` with the awkward setups that broke mustfail before (spaces in paths, a bare `globalSetup` name, `maxFailures`, an import from `playwright/test`, an output folder outside the project).

## Feedback

Most useful: a grade you think is wrong, with the test (or a cut-down copy) and the reason mustfail gave. Open an issue at https://github.com/ashwink-tech/mustfail/issues. Please leave out response data from your own environment; the reason text and the test source are enough.

## License

MIT. Built by Ashwin ([ashwink-tech](https://github.com/ashwink-tech)).
