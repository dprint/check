#!/usr/bin/env -S deno run -A
import $ from "@david/dax";
import { concat, defineMatrix, expr, hashFiles, isLinting, job, step, workflow } from "@david/gagen";

const matrix = defineMatrix({
  os: ["ubuntu-latest", "macOS-latest", "windows-latest"],
});

// a copy of dprint.json with a comment unique to this run, so the cache jobs
// get a cache key hash no other run has and can assert on their own entries
const cacheTestConfig = "cache-test.json";
const runUniqueId = concat(expr("github.run_id"), "-", expr("github.run_attempt"));
const createCacheTestConfig = [
  "{",
  `  echo "// ${runUniqueId}"`,
  "  cat dprint.json",
  `} > ${cacheTestConfig}`,
];
const createPoorlyFormattedFile = `echo '{"a": 1, "b": 2}' > poorly-formatted.json`;

const checkout = step({
  uses: "actions/checkout@v7",
});
// windows checks out with crlf line endings by default, which dprint flags
const checkoutWithLf = step({
  name: "Use LF line endings",
  run: [
    "git config --global core.autocrlf false",
    "git config --global core.eol lf",
  ],
}, checkout);

// === style job ===

const specificVersionCheck = step({
  name: "Check formatting specific version",
  id: "specific-version",
  uses: "./",
  with: { "dprint-version": "0.57.1" },
  outputs: ["dprint-version"] as const,
});
const unattestedVersionCheck = step({
  name: "Check formatting with an unattested version",
  id: "unattested-version",
  uses: "./",
  with: { "dprint-version": "0.56.1", "config-path": "tests/legacy/dprint.json" },
  outputs: ["dprint-version"] as const,
});

const workingDirectoryCheck = step({
  name: "Check formatting in a working directory",
  id: "working-directory",
  uses: "./",
  with: { "working-directory": "tests/working-dir", "config-path": "dprint.json", cache: true },
  outputs: ["unformatted-count"] as const,
});

const styleJob = job("style", {
  runsOn: matrix.os,
  strategy: { matrix },
  defaults: { run: { shell: "bash" } },
  steps: step.dependsOn(checkoutWithLf)(
    {
      name: "Check formatting latest",
      uses: "./",
    },
    specificVersionCheck,
    {
      name: "Verify the specific version was installed",
      env: { VERSION: specificVersionCheck.outputs["dprint-version"] },
      run: `test "$VERSION" = "0.57.1"`,
    },
    {
      name: "Check formatting specific config",
      uses: "./",
      with: { "config-path": "dprint.json" },
    },
    {
      name: "Check formatting specific version and config",
      uses: "./",
      with: { "dprint-version": "0.57.1", "config-path": "dprint.json" },
    },
    {
      name: "Check formatting with cache",
      uses: "./",
      with: { cache: true },
    },
    {
      name: "Check formatting with cache and specific version",
      uses: "./",
      with: { cache: true, "dprint-version": "0.57.1" },
    },
    {
      name: "Check formatting without attestation verification",
      uses: "./",
      with: { "verify-attestation": false },
    },
    {
      name: "Check formatting without annotations",
      uses: "./",
      with: { annotations: false },
    },
    // a version from before attestations, so the download can't be verified and
    // the action warns instead; it predates npm plugin specifiers too, so it
    // checks a config with an https plugin
    unattestedVersionCheck,
    {
      name: "Verify the unattested version was installed",
      env: { VERSION: unattestedVersionCheck.outputs["dprint-version"] },
      run: `test "$VERSION" = "0.56.1"`,
    },
    {
      name: "Make poorly-formatted json file",
      run: createPoorlyFormattedFile,
    },
    {
      name: "Check formatting with excludes",
      uses: "./",
      with: { args: "--excludes poorly-formatted.json" },
    },
    // the poorly-formatted file at the root would fail this if the check
    // didn't run in the directory, and the config path is relative to it
    workingDirectoryCheck,
    {
      name: "Verify the working directory was checked",
      env: { UNFORMATTED_COUNT: workingDirectoryCheck.outputs["unformatted-count"] },
      run: `test "$UNFORMATTED_COUNT" = "0"`,
    },
    {
      name: "Later steps can run dprint with the same cache",
      run: [
        `test -n "$DPRINT_CACHE_DIR"`,
        `test -d "$DPRINT_CACHE_DIR/plugins"`,
        "dprint --version",
      ],
    },
  ),
});

// === cache job ===

// the prefix of the cache keys for the unique config, which only this run's
// entries have
const cacheTestPrefix = concat(
  "dprint-cache-",
  expr("runner.os"),
  "-",
  expr("runner.arch"),
  "-",
  hashFiles(cacheTestConfig),
);

// uses its own cache directory so the later checks don't see what it compiled
const cacheNoSaveCheck = step({
  name: "Check formatting without saving the cache (expected to fail)",
  id: "no-save",
  uses: "./",
  continueOnError: true,
  env: { DPRINT_CACHE_DIR: concat(expr("runner.temp"), "/dprint-cache-no-save") },
  with: { cache: true, "cache-save": false, "config-path": cacheTestConfig },
  outputs: ["cache-matched-key", "cache-changed", "cache-saved"] as const,
});

const cachePrimeCheck = step({
  name: "Check formatting (expected to fail)",
  id: "prime",
  uses: "./",
  continueOnError: true,
  with: { cache: true, "config-path": cacheTestConfig },
  outputs: ["cache-matched-key", "cache-changed", "cache-saved", "unformatted-count", "unformatted-files"] as const,
});

const cacheHitCheck = step({
  name: "Check formatting again",
  id: "hit",
  uses: "./",
  with: { cache: true, "config-path": cacheTestConfig },
  outputs: ["cache-matched-key", "cache-changed", "cache-saved", "unformatted-count", "unformatted-files"] as const,
});

// the runs happen in one job so they share a runner: a second job could land
// on a runner with different cpu features, which would compile its own plugin
// variants and change the cache, and re-running only failed jobs would lose the
// entry the first run saved
const cacheJob = job("cache", {
  runsOn: matrix.os,
  strategy: { matrix },
  defaults: { run: { shell: "bash" } },
  steps: step.dependsOn(checkoutWithLf)(
    {
      name: "Create unique config and poorly-formatted file",
      run: [...createCacheTestConfig, createPoorlyFormattedFile],
    },
    cacheNoSaveCheck,
    {
      name: "Verify the cache changed but wasn't saved",
      env: {
        MATCHED_KEY: cacheNoSaveCheck.outputs["cache-matched-key"],
        CACHE_CHANGED: cacheNoSaveCheck.outputs["cache-changed"],
        CACHE_SAVED: cacheNoSaveCheck.outputs["cache-saved"],
        CACHE_TEST_PREFIX: cacheTestPrefix,
      },
      run: [
        `test "${expr("steps.no-save.outcome")}" = "failure"`,
        `echo "matched key: $MATCHED_KEY"`,
        // no entry exists for the unique config yet
        `case "$MATCHED_KEY" in "$CACHE_TEST_PREFIX"*) exit 1 ;; esac`,
        `test "$CACHE_CHANGED" = "true"`,
        `test "$CACHE_SAVED" = "false"`,
      ],
    },
    cachePrimeCheck,
    {
      name: "Verify the check failed, reported the file and the cache was saved",
      env: {
        MATCHED_KEY: cachePrimeCheck.outputs["cache-matched-key"],
        CACHE_CHANGED: cachePrimeCheck.outputs["cache-changed"],
        CACHE_SAVED: cachePrimeCheck.outputs["cache-saved"],
        UNFORMATTED_COUNT: cachePrimeCheck.outputs["unformatted-count"],
        UNFORMATTED_FILES: cachePrimeCheck.outputs["unformatted-files"],
        CACHE_TEST_PREFIX: cacheTestPrefix,
      },
      run: [
        `test "${expr("steps.prime.outcome")}" = "failure"`,
        `echo "matched key: $MATCHED_KEY"`,
        // the check without saving didn't leave an entry behind
        `case "$MATCHED_KEY" in "$CACHE_TEST_PREFIX"*) exit 1 ;; esac`,
        `test "$CACHE_CHANGED" = "true"`,
        `test "$CACHE_SAVED" = "true"`,
        `test "$UNFORMATTED_COUNT" = "1"`,
        `test "$UNFORMATTED_FILES" = "poorly-formatted.json"`,
      ],
    },
    {
      name: "Remove the poorly-formatted file",
      run: "rm poorly-formatted.json",
    },
    cacheHitCheck,
    {
      name: "Verify the cache saved by the failed check was restored and not saved again",
      env: {
        MATCHED_KEY: cacheHitCheck.outputs["cache-matched-key"],
        CACHE_CHANGED: cacheHitCheck.outputs["cache-changed"],
        CACHE_SAVED: cacheHitCheck.outputs["cache-saved"],
        UNFORMATTED_COUNT: cacheHitCheck.outputs["unformatted-count"],
        UNFORMATTED_FILES: cacheHitCheck.outputs["unformatted-files"],
        EXPECTED_KEY: concat(cacheTestPrefix, "-", expr("github.job"), "-", runUniqueId),
      },
      run: [
        `echo "matched key: $MATCHED_KEY"`,
        `echo "expected:    $EXPECTED_KEY"`,
        `test "$MATCHED_KEY" = "$EXPECTED_KEY"`,
        // nothing new was checked, so the restored cache is left as-is
        `test "$CACHE_CHANGED" = "false"`,
        `test "$CACHE_SAVED" = "false"`,
        `test "$UNFORMATTED_COUNT" = "0"`,
        `test -z "$UNFORMATTED_FILES"`,
      ],
    },
  ),
});

// === lint job ===

const lintJob = job("lint", {
  runsOn: "ubuntu-latest",
  steps: step.dependsOn(checkout)(
    step({
      uses: "denoland/setup-deno@v2",
    }),
    step({
      name: "Lint generated files",
      run: [
        // deno run doesn't type check, so a type error in a generator script
        // would silently produce bad yaml
        "deno check .github/workflows/*.ts",
        "./.github/workflows/ci.ts --lint",
        "./.github/workflows/action.ts --lint",
      ],
    }),
    step({
      name: "Test annotation script",
      run: "deno test -A scripts/",
    }),
  ),
});

// === generate ===

workflow({
  name: "CI",
  on: ["push", "pull_request"],
  jobs: [
    styleJob,
    cacheJob,
    lintJob,
  ],
}).writeOrLint({
  filePath: new URL("./ci.generated.yml", import.meta.url),
  header: "# GENERATED BY ./ci.ts -- DO NOT DIRECTLY EDIT",
});

if (!isLinting) {
  await $`dprint fmt --log-level=warn "**/*.yml"`;
}
