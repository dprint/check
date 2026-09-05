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
  annotations: {
    description: "Emit a GitHub Actions error annotation for each file that isn't formatted (requires dprint 0.57+)",
    required: false,
    default: "true",
  },
  "verify-attestation": {
    description:
      "Verify the build provenance attestation of the downloaded dprint executable (requires dprint 0.57.1+)",
    required: false,
    default: "true",
  },
});

const cacheEnabled = inputs.cache.equals("true");
const cacheDir = expr("env.DPRINT_CACHE_DIR");

// the executable is downloaded from the GitHub release and its build provenance
// attestation (available from dprint 0.57.1) is verified, so nothing outside of
// GitHub is trusted; gh is available on all GitHub-hosted runners, and without
// it the asset is downloaded from GitHub releases unverified
const download = step({
  name: "Download dprint",
  id: "download",
  env: {
    DPRINT_VERSION: inputs["dprint-version"],
    VERIFY_ATTESTATION: inputs["verify-attestation"],
    GH_TOKEN: expr("github.token"),
  },
  run: [
    `case "$RUNNER_OS-$RUNNER_ARCH" in`,
    `  Linux-X64) target="x86_64-unknown-linux" ;;`,
    `  Linux-ARM64) target="aarch64-unknown-linux" ;;`,
    `  macOS-X64) target="x86_64-apple-darwin" ;;`,
    `  macOS-ARM64) target="aarch64-apple-darwin" ;;`,
    `  Windows-X64) target="x86_64-pc-windows-msvc" ;;`,
    `  Windows-ARM64) target="aarch64-pc-windows-msvc" ;;`,
    `  *) echo "Unsupported runner: $RUNNER_OS $RUNNER_ARCH" >&2; exit 1 ;;`,
    `esac`,
    `if [ "$RUNNER_OS" = "Linux" ]; then`,
    `  if ldd /bin/sh | grep -q musl; then target="$target-musl"; else target="$target-gnu"; fi`,
    `fi`,
    `asset="dprint-$target.zip"`,
    `zip="$RUNNER_TEMP/$asset"`,
    `verifiable=false`,
    `if command -v gh > /dev/null; then`,
    `  version="\${DPRINT_VERSION:-$(gh release view --repo dprint/dprint --json tagName --jq .tagName)}"`,
    `  gh release download "$version" --repo dprint/dprint --pattern "$asset" --output "$zip" --clobber`,
    `  # releases before 0.57.1 don't have attestations`,
    `  if [ "$VERIFY_ATTESTATION" != "true" ]; then`,
    `    echo "Attestation verification is disabled."`,
    `  elif [ "$(printf '%s\\n' 0.57.1 "$version" | sort -V | head -n 1)" = "0.57.1" ]; then`,
    `    verifiable=true`,
    `  else`,
    `    echo "::warning title=dprint::dprint $version predates build provenance attestations, so $asset can't be verified. Upgrade to dprint 0.57.1 or later to have the download verified."`,
    `  fi`,
    `else`,
    `  if [ "$VERIFY_ATTESTATION" = "true" ]; then`,
    `    echo "::warning title=dprint::The GitHub CLI (gh) is not available on this runner, so $asset can't be verified. Install it to have the download verified."`,
    `  fi`,
    `  version="$DPRINT_VERSION"`,
    `  if [ -n "$version" ]; then`,
    `    url="https://github.com/dprint/dprint/releases/download/$version/$asset"`,
    `  else`,
    `    url="https://github.com/dprint/dprint/releases/latest/download/$asset"`,
    `  fi`,
    `  curl -fsSL --output "$zip" "$url"`,
    `fi`,
    `echo "Downloaded $asset\${version:+ for dprint $version}."`,
    `echo "zip=$zip" >> "$GITHUB_OUTPUT"`,
    `echo "verifiable=$verifiable" >> "$GITHUB_OUTPUT"`,
  ],
  outputs: ["zip", "verifiable"] as const,
});

const verify = step({
  name: "Verify dprint",
  if: download.outputs.verifiable.equals("true"),
  env: {
    ZIP: download.outputs.zip,
    GH_TOKEN: expr("github.token"),
  },
  run: [
    `gh attestation verify "$ZIP" --repo dprint/dprint`,
    `echo "Verified the build provenance attestation of $(basename "$ZIP")."`,
  ],
}).dependsOn(download);

const install = step({
  name: "Install dprint",
  env: { ZIP: download.outputs.zip },
  run: [
    `bin_dir="$HOME/.dprint/bin"`,
    `mkdir -p "$bin_dir"`,
    `unzip -o -q "$ZIP" -d "$bin_dir"`,
    `chmod +x "$bin_dir"/dprint*`,
    `if [ "$RUNNER_OS" = "Windows" ]; then`,
    `  cygpath -w "$bin_dir" >> "$GITHUB_PATH"`,
    `else`,
    `  echo "$bin_dir" >> "$GITHUB_PATH"`,
    `fi`,
    `"$bin_dir/dprint" --version`,
  ],
}).dependsOn(download).comesAfter(verify);

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

// with annotations enabled, the check runs with --json and the output is
// turned into readable diffs and annotations by a script; dprint before 0.57
// rejects --json with exit code 10 (argument parsing error), in which case
// the check just runs again without it
const check = step({
  name: "Check formatting",
  env: {
    CONFIG_PATH: configPath,
    ANNOTATIONS: inputs.annotations,
    ANNOTATE_SCRIPT: concat(expr("github.action_path"), "/scripts/annotate.mjs"),
  },
  run: [
    `args=(\${CONFIG_PATH:+--config "$CONFIG_PATH"} ${inputs.args})`,
    `if [ "$ANNOTATIONS" = "true" ] && command -v node > /dev/null; then`,
    `  output="$RUNNER_TEMP/dprint-check.jsonl"`,
    `  set +e`,
    `  ~/.dprint/bin/dprint check --json "\${args[@]}" > "$output" 2> "$output.stderr"`,
    `  code=$?`,
    `  set -e`,
    `  if [ "$code" != 10 ]; then`,
    `    cat "$output.stderr" >&2`,
    `    node "$ANNOTATE_SCRIPT" "$output"`,
    `    exit "$code"`,
    `  fi`,
    `fi`,
    `~/.dprint/bin/dprint check "\${args[@]}"`,
  ],
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
    "cache-changed": {
      description: "Whether the check changed the cache and so a new cache entry was saved",
      value: hashCacheAfter.outputs.changed,
    },
  },
  defaults: { run: { shell: "bash" } },
  steps: [download, verify, install, restoreCache, hashCacheBefore, check, hashCacheAfter, saveCache],
  branding: { icon: "check-circle", color: "gray-dark" },
}).writeOrLint({
  filePath: new URL("../../action.yml", import.meta.url),
  header: "# GENERATED BY ./.github/workflows/action.ts -- DO NOT DIRECTLY EDIT",
});

if (!isLinting) {
  await $`dprint fmt --log-level=warn action.yml`;
}
