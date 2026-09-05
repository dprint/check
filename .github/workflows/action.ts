#!/usr/bin/env -S deno run -A
import $ from "@david/dax";
import { action, concat, conditions, defineInputs, expr, hashFiles, isLinting, step } from "@david/gagen";

const inputs = defineInputs({
  "dprint-version": {
    description: "Specific dprint version to use (ex. 0.30.3)",
    required: false,
    default: "",
  },
  "config-path": {
    description: "Specific dprint config to use (ex. dprint.json)",
    required: false,
    default: "",
  },
  args: {
    description: "Additional arguments to pass to dprint check",
    required: false,
    default: "",
  },
  cache: {
    description: "Cache dprint's plugins and incremental state in the GitHub Actions cache (ex. true)",
    required: false,
    default: "false",
  },
});

const cacheEnabled = inputs.cache.equals("true");
const cacheDir = expr("env.DPRINT_CACHE_DIR");

const install = step({
  name: "Install dprint",
  run: [
    `curl -fsSL https://dprint.dev/install.sh | sh -s ${inputs["dprint-version"]} > /dev/null 2>&1`,
    `if [ "$RUNNER_OS" = "Windows" ]; then`,
    `  cygpath -w "$HOME/.dprint/bin" >> "$GITHUB_PATH"`,
    `else`,
    `  echo "$HOME/.dprint/bin" >> "$GITHUB_PATH"`,
    `fi`,
  ],
});

// the hash of the config file the check will use, or of every config file in
// the repo when dprint discovers the config itself (a remote config url can't
// be hashed, so that falls back to the repo's config files too)
const configPath = inputs["config-path"];
const configHash = configPath.notEquals("")
  .and(configPath.startsWith("http").not())
  .then(hashFiles(configPath))
  .else(hashFiles("**/dprint.json", "**/dprint.jsonc", "**/.dprint.json", "**/.dprint.jsonc"));

const prepareCache = step({
  name: "Prepare dprint cache",
  id: "cache-key",
  if: cacheEnabled,
  env: { CONFIG_HASH: configHash },
  run: [
    `# respect a directory the user already set so later steps share the same cache`,
    `if [ -z "\${DPRINT_CACHE_DIR:-}" ]; then`,
    `  cache_dir="$RUNNER_TEMP/dprint-cache"`,
    `  if [ "$RUNNER_OS" = "Windows" ]; then`,
    `    cache_dir=$(cygpath -w "$cache_dir")`,
    `  fi`,
    `  echo "DPRINT_CACHE_DIR=$cache_dir" >> "$GITHUB_ENV"`,
    `fi`,
    `echo "platform-prefix=dprint-cache-$RUNNER_OS-$RUNNER_ARCH" >> "$GITHUB_OUTPUT"`,
    `echo "config-prefix=dprint-cache-$RUNNER_OS-$RUNNER_ARCH-$CONFIG_HASH" >> "$GITHUB_OUTPUT"`,
  ],
  outputs: ["platform-prefix", "config-prefix"] as const,
});

// the incremental state changes every run, so each run saves under a unique
// key and restores by prefix: first a previous run of this job with the same
// config, then any job with the same config, then anything for this platform;
// dprint validates the restored plugins and incremental state itself, so a
// stale match is always safe
const configPrefix = prepareCache.outputs["config-prefix"];
const restoreCache = step({
  name: "Restore dprint cache",
  id: "restore-cache",
  if: cacheEnabled,
  uses: "actions/cache/restore@v5",
  with: {
    path: cacheDir,
    key: concat(configPrefix, "-", expr("github.job"), "-", expr("github.run_id"), "-", expr("github.run_attempt")),
    "restore-keys": [
      concat(configPrefix, "-", expr("github.job"), "-"),
      concat(configPrefix, "-"),
      concat(prepareCache.outputs["platform-prefix"], "-"),
    ].join("\n"),
  },
  outputs: ["cache-hit", "cache-primary-key", "cache-matched-key"] as const,
}).dependsOn(prepareCache);

// hashes the contents of the cache directory before and after the check so
// the save can be skipped when the check didn't change anything
const hashCacheDir = [
  `hash_cache_dir() {`,
  `  if [ ! -d "$DPRINT_CACHE_DIR" ]; then`,
  `    echo "missing"`,
  `    return`,
  `  fi`,
  `  cd "$DPRINT_CACHE_DIR"`,
  `  # the locks directory changes on every run`,
  `  local files`,
  `  files=$(find . -type f -not -path "./locks/*" | LC_ALL=C sort)`,
  `  if [ -z "$files" ]; then`,
  `    echo "empty"`,
  `    return`,
  `  fi`,
  `  { echo "$files"; echo "$files" | xargs git hash-object; } | git hash-object --stdin`,
  `}`,
];
const hashCacheBefore = step({
  name: "Hash dprint cache before check",
  id: "cache-before",
  if: cacheEnabled,
  run: [
    ...hashCacheDir,
    `echo "hash=$(hash_cache_dir)" >> "$GITHUB_OUTPUT"`,
  ],
  outputs: ["hash"] as const,
}).dependsOn(restoreCache);

const check = step({
  name: "Check formatting",
  env: { CONFIG_PATH: configPath },
  run: `~/.dprint/bin/dprint check \${CONFIG_PATH:+--config "$CONFIG_PATH"} ${inputs.args}`,
}).dependsOn(install).comesAfter(hashCacheBefore);

// runs even when the check fails so the compiled plugins and the incremental
// state of the correctly formatted files can still be saved
const hashCacheAfter = step({
  name: "Check if dprint cache changed",
  id: "cache-after",
  if: conditions.status.always().and(cacheEnabled),
  env: { HASH_BEFORE: hashCacheBefore.outputs.hash },
  run: [
    ...hashCacheDir,
    `hash_after=$(hash_cache_dir)`,
    `echo "before: $HASH_BEFORE"`,
    `echo "after:  $hash_after"`,
    `if [ "$hash_after" = "$HASH_BEFORE" ]; then`,
    `  echo "changed=false" >> "$GITHUB_OUTPUT"`,
    `else`,
    `  echo "changed=true" >> "$GITHUB_OUTPUT"`,
    `fi`,
  ],
  outputs: ["changed"] as const,
}).comesAfter(check);

const saveCache = step({
  name: "Save dprint cache",
  if: conditions.status.always()
    .and(cacheEnabled)
    .and(restoreCache.outputs["cache-primary-key"].notEquals(""))
    .and(restoreCache.outputs["cache-hit"].notEquals("true"))
    .and(hashCacheAfter.outputs.changed.equals("true")),
  uses: "actions/cache/save@v5",
  with: {
    path: cacheDir,
    key: restoreCache.outputs["cache-primary-key"],
  },
}).comesAfter(hashCacheAfter);

action({
  name: "dprint-check-action",
  description: "Run `dprint check` on your source code",
  author: "the dprint authors",
  inputs,
  outputs: {
    "cache-matched-key": {
      description: "Key of the cache entry that was restored, if any",
      value: restoreCache.outputs["cache-matched-key"],
    },
  },
  defaults: { run: { shell: "bash" } },
  steps: [install, restoreCache, hashCacheBefore, check, hashCacheAfter, saveCache],
  branding: { icon: "check-circle", color: "gray-dark" },
}).writeOrLint({
  filePath: new URL("../../action.yml", import.meta.url),
  header: "# GENERATED BY ./.github/workflows/action.ts -- DO NOT DIRECTLY EDIT",
});

if (!isLinting) {
  await $`dprint fmt --log-level=warn action.yml`;
}
