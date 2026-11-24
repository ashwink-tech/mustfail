# mustfail

`mustfail` finds Playwright tests that stay green when the app is broken. It runs your suite while it fails or changes your API's responses, then reports which tests noticed. You don't edit your tests or your config.

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

mustfail also writes an HTML report to `.mustfail/report.html`. Click a grade to see its tests, or type to filter by test name or file.

**Requirements:** Node 20 or newer (20.6+ for ES-module projects) and `@playwright/test` 1.50 or newer. mustfail has no dependencies.

**Network:** mustfail makes no calls of its own. It changes responses on their way from your app to the browser, through Playwright, and writes its report to a local folder.

> **Alpha.** Run it against a local or disposable environment. Fault runs repeat your tests' requests, writes included, even the ones no fault targets.

## What the grades mean

| Grade | Rule |
| --- | --- |
| **Decorative** | Passed a run where every API call returned 500, or ran no assertion |
| **Weak** | Failed that run, but passed when mustfail changed its own data or failed its own write (a create, update, delete or save returned 500 and nothing it checks noticed) |
| **No data check** | Fails when the page can't load, but none of its assertions ties to a server value, and it stayed green when mustfail changed or emptied its data. Fine for browser-only behaviour like form rules or date pickers; a gap if you meant the test to verify data |
| **Strong** | An assertion failed when mustfail changed a value the test displays, emptied its list, flipped the true/false fields in its rows, or failed its write. Marked "via a helper" when the only failing assertion sits in a setup helper (`createX`, `waitForX`) rather than the test or a check helper (`expectX`, `verifyX`) |
| **Request check** | Its real check reads the request the page sent (`request.postData()`, `postDataJSON()`), and no server fault can change that. Tests with other grades that also check their request say so in their reason |
| **Write-gated** | Stops when its own write fails, but only because a click or wait timed out. It waits for the save, and no assertion checks the result. If that write is only setup, the grade tells you little about what the test is for |
| **Unproven** | Needs the data (fails when it's gone), but no assertion mustfail can read ties to its values, and changing them didn't make it fail |
| **Not measurable** | Fails or flakes without faults, is marked `test.fail()` (a known open bug), makes no API calls in the browser, checks data it mocks itself, mocks a 4xx/5xx itself, or its key fault runs broke in setup for a reason the fault can't explain (see below) |

## How it works

1. **Baseline.** mustfail runs your suite twice with no faults. It records each test's API calls, the shape of every JSON response per endpoint (so it sees a list the app fetches again after the test creates a row), and the text each passing assertion checked. It leaves out tests that fail or flip between the two runs.
2. **Plan.** Each test gets one blackout run and up to three targeted faults (`--max-targeted`). On top of those come probes of the page's main list, one failed write of the test's own and, if it checks booleans, one flip of them. mustfail picks targets by matching the text your assertions checked against response values: a test that asserts `42.00` gets the field `total: 42` changed. A value the test created itself counts as a match even when the assertion only checks that the row is visible. mustfail spots those as values with digits in them (a generated name, say) that turn up only in a later response.
3. **Fault runs.** mustfail runs them all in one Playwright invocation with `--repeat-each`, on your config's workers and projects, and applies faults with `context.route`. It leaves login and session endpoints alone, and the signed-in user's own record (`/me`, `/users/me`) with them. So it can't prove a test that only shows the user's name or email.
4. **Retry of broken setups.** Sometimes a fault run fails before the test body starts, and its fault hasn't touched a single request. The fault didn't cause that. Most often an earlier test failed partway (fault runs make tests fail) and skipped the cleanup at the end of its body, leaving a setting on, a rate limit hit or leftover data behind. mustfail re-runs the tests that failed just before each such stretch with no fault, since their passing run tends to undo the damage. Then it retries the broken runs once. The report shows the error and the suspects. A test whose key runs still broke gets "not measurable" instead of a grade built on what was left. To fix it in your suite, move that cleanup into `afterEach` or a `finally` block. That also protects you when a real bug makes the test fail.
5. **Second look.** Each strong or write-gated grade rests on one run, so mustfail repeats that run once. If the two disagree (an assertion failed one time, a wait timed out the other), the weaker result counts and the test's notes say so. Skip this with `--no-confirm`.

Run it again into the same output folder and the new report ends with the tests whose grade changed (stronger, weaker, other). The HTML report shows each one's previous grade.

mustfail hooks in at load time. In your own files, imports of `@playwright/test` (and `playwright/test`) resolve to a thin wrapper that adds the fixtures. Playwright runs from the folder you started mustfail in, as `npx playwright test -c <config>` would. mustfail writes nothing to your repo except the output folder (`.mustfail/` by default). The temporary config that wraps yours lives there, and mustfail removes it at the end.

That config is yours with a few settings changed for the run:

- retries off, and mustfail's reporter in place of yours
- `maxFailures` off, since fault runs fail on purpose
- projects that others depend on (login, seeding) run once rather than once per repeat
- `globalTimeout` multiplied by the number of times each test runs
- `updateSnapshots: 'none'` during fault runs, so a page showing wrong data can't write or replace a snapshot

`baseline.json` and `plan.json` in the output folder hold samples of what your API returned: names, emails, whatever the app shows. mustfail adds a `.gitignore` to the folder to keep them out of git. Treat both files like test data from that environment. `report.html` and `report.json` hold field names, endpoints and error lines, and no response values.

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

Exit codes:

- **0:** the run finished, whatever the grades, unless `--fail-on` matched
- **1:** `--fail-on` matched, or mustfail crashed
- **2:** a usage or setup problem (no config, no `@playwright/test`, no tests listed)

Ctrl-C or a CI timeout stops Playwright and its web server, and mustfail removes its temporary config.

## In CI

Read a first report and agree with it before you gate a build on grades. Then, in GitHub Actions for example:

```yaml
- run: npx mustfail run --yes --fail-on decorative -- --project=chromium
- uses: actions/upload-artifact@v4
  if: always()
  with: { name: mustfail-report, path: .mustfail/report.html }
```

CI has no terminal, so mustfail skips the prompt anyway; `--yes` makes that explicit. A full run takes 3 to 4 times your suite's runtime, so run it on a schedule or on pull requests that touch tests, not on every push.

## Limits today

- **mustfail only sees tests that get `test` from your own files.** It can't reach a `test` that comes from a package in `node_modules` (a shared fixtures package), a browser context the test creates itself (`browser.newContext()`), or API-only tests. It grades those not measurable, and tells you when it saw no test at all.
- **mustfail recognises a save by its shape.** For GraphQL, that's a saving verb in the operation name. For REST, it's PUT, PATCH, DELETE, a saving verb in the path, or a POST the server answered with 201. mustfail still fails a create that answers 200 on a plain path (`POST /orders`) once, but a test that stays green then doesn't get "weak".
- **ES-module projects need Node 20.6 or newer.** mustfail redirects projects with `"type": "module"` or an `.mjs`/`.mts` config through a Node loader hook (`module.register`), and CommonJS projects through a `--require` hook.
- **Browser traffic only.** Data your app fetches on the server (Next.js SSR, server components) never reaches the browser, so tests that depend on it come out not measurable. So do API-only tests using `request`, and tests that create their own browser context.
- **mustfail can't fault requests.** It changes responses, not what the app sends. It recognises a test that asserts what it sent (graded "request check", or noted in the reason) but can't prove it.
- **mustfail flips booleans only when the test shows signs of reading them.** A test asserting `toBeChecked`, `toBeEnabled` or `toBeDisabled` gets one extra fault that flips the true/false fields in the rows of a list it reads. That happens when its checked text comes from that list, or when a boolean in the list changed between responses. Booleans outside lists, or in lists with neither sign, stay as they are.
- **mustfail reads the first five rows of a list** for matching. A row your test creates far down a long list won't link to its assertion.
- **A strong grade means some assertion failed.** It doesn't tell you the one you care about did. When the only failing assertion sits in a helper whose name has no check verb (`createMetric`, `waitForTile`, as opposed to `expectRow` or `verifyTotal`), mustfail marks the grade "strong (via a helper)" and names the helper. That's often a page object checking the setup it just did, while the test's own check is a count or a boolean mustfail can't see. mustfail tells helpers apart by name only.
- **A changed value that breaks a click proves nothing.** A test that finds a row by the value mustfail changed stops on the click before any assertion runs. It doesn't get "strong", but its reason says the wrong value stopped it.
- **Unproven also covers tests that only need the app's own configuration.** When the blackout breaks a test in setup, the next fault that breaks it is often an emptied schema or menu list (`/init`, content-type definitions). The grade stays unproven, and the reason says so when most tests in the run read that call. If you run one feature's folder, most of its tests read that feature's own list too, so treat the wording as a hint.
- **The suspects in a broken-setup warning are a shortlist.** Tests in one file run back to back, so the one that leaked state looks the same as its neighbours. The retry fixes the grades either way.
- **mustfail repeats only the deciding run.** A test with a race in it can stop at a different step each time: a wait one run, an assertion the next. mustfail runs the deciding run of a strong or write-gated grade twice and counts the weaker result. Two runs catch such a race often, not always, and mustfail runs the deciding run of any other grade once.
- **Two baseline runs** catch some flaky tests and miss others.
- **Runtime:** a full run takes about 3 to 4 times your suite's runtime. Pass extra Playwright args to scope it.
- **Tested on Playwright 1.50 to 1.65** (1.50, 1.53, 1.56, 1.59, 1.62 and 1.65, every example grade identical) and Node 20, 22 and 24, on Linux, macOS and Windows, with Chrome, Firefox and WebKit (every example grade identical in CI). Also run with Chrome/Chromium against two real suites: a large private suite, and Strapi's admin, settings and content-manager e2e tests (200+ tests).

## How this differs from similar tools

| Tool | Approach | Needs test changes |
| --- | --- | --- |
| **mustfail** | Fails or changes real API responses at runtime and checks whether each test notices | No |
| playwright-mutation-gate | Inverts each test's primary assertion and checks the test goes red | Yes, mark one assertion per test |
| falsegreen, hollowtest, vacuous | Read test source for patterns that can't fail (no assertion, tautologies) | No, but can't see runtime behaviour |
| Stryker and other mutation tools | Change application source and run unit tests | No, but unit-level rather than end-to-end |

## Development

```
npm test            # unit tests (node:test, no dependencies)
npm run test:e2e    # runs mustfail on examples/tasks, tasks-esm, cart and cart-odd and compares every grade with test/expected/
node test/e2e.js --update        # rewrite the snapshots after an intended change (review the diff)
node test/matrix.js 1.50.1 1.65.1  # the tasks example against other @playwright/test versions
```

The examples need Google Chrome installed (they use `channel: 'chrome'`). The e2e script generates `examples/tasks-esm` from `examples/tasks`, so edit the tasks app and leave the copy alone. It also generates `examples/cart odd` from `examples/cart`, with the awkward setups that broke mustfail before: spaces in paths, a bare `globalSetup` name, `maxFailures`, an import from `playwright/test` and an output folder outside the project.

## Feedback

The most useful report is a grade you think is wrong. Send the test (or a cut-down copy) and the reason mustfail gave, in an issue at https://github.com/ashwink-tech/mustfail/issues. Leave out response data from your own environment; the reason and the test source are enough.

## License

MIT. Built by Ashwin ([ashwink-tech](https://github.com/ashwink-tech)).
