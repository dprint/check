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

// === cache jobs ===

const cachePrimeCheck = step({
  name: "Check formatting (expected to fail)",
  id: "check",
  uses: "./",
  continueOnError: true,
  with: { cache: true, "config-path": cacheTestConfig },
  outputs: ["cache-changed"] as const,
});

const cachePrimeJob = job("cache-prime", {
  runsOn: matrix.os,
  strategy: { matrix },
  defaults: { run: { shell: "bash" } },
  steps: step.dependsOn(checkoutWithLf)(
    {
      name: "Create unique config and poorly-formatted file",
      run: [...createCacheTestConfig, createPoorlyFormattedFile],
    },
    cachePrimeCheck,
    {
      name: "Verify the check failed and the cache was saved",
      env: { CACHE_CHANGED: cachePrimeCheck.outputs["cache-changed"] },
      run: [
        `test "${expr("steps.check.outcome")}" = "failure"`,
        `test "$CACHE_CHANGED" = "true"`,
      ],
    },
  ),
});

const cacheHitCheck = step({
  name: "Check formatting",
  id: "check",
  uses: "./",
  with: { cache: true, "config-path": cacheTestConfig },
  outputs: ["cache-matched-key", "cache-changed"] as const,
});

const cacheHitJob = job("cache-hit", {
  runsOn: matrix.os,
  strategy: { matrix },
  needs: [cachePrimeJob],
  defaults: { run: { shell: "bash" } },
  steps: step.dependsOn(checkoutWithLf)(
    {
      name: "Recreate unique config",
      run: createCacheTestConfig,
    },
    cacheHitCheck,
    {
      name: "Verify the cache saved by the failed cache-prime job was restored and not saved again",
      env: {
        MATCHED_KEY: cacheHitCheck.outputs["cache-matched-key"],
        CACHE_CHANGED: cacheHitCheck.outputs["cache-changed"],
        EXPECTED_KEY: concat(
          "dprint-cache-",
          expr("runner.os"),
          "-",
          expr("runner.arch"),
          "-",
          hashFiles(cacheTestConfig),
          "-",
          cachePrimeJob.id,
          "-",
          runUniqueId,
        ),
      },
      run: [
        `echo "matched key: $MATCHED_KEY"`,
        `echo "expected:    $EXPECTED_KEY"`,
        `test "$MATCHED_KEY" = "$EXPECTED_KEY"`,
        // nothing new was checked, so the restored cache is left as-is
        `if [ "$CACHE_CHANGED" != "false" ]; then`,
        `  echo "::error title=cache-hit::The cache changed even though nothing new was checked. This happens when this job ran on a runner with different cpu features than the cache-prime job and the plugins compiled for them weren't in the cache yet (see the Compiling lines above). Re-run the workflow: the next cache-prime job restores the entry this job saved, which has the plugins compiled for both."`,
        `  exit 1`,
        `fi`,
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
    cachePrimeJob,
    cacheHitJob,
    lintJob,
  ],
}).writeOrLint({
  filePath: new URL("./ci.generated.yml", import.meta.url),
  header: "# GENERATED BY ./ci.ts -- DO NOT DIRECTLY EDIT",
});

if (!isLinting) {
  await $`dprint fmt --log-level=warn "**/*.yml"`;
}
