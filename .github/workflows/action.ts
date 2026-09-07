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
  "working-directory": {
    description: "Directory to run dprint check in, relative to the workspace (ex. packages/app)",
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
const resolve = step({
  name: "Resolve dprint version",
  id: "resolve",
  env: {
    DPRINT_VERSION: inputs["dprint-version"],
    CACHE: inputs.cache,
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
    `version="$DPRINT_VERSION"`,
    `digest=""`,
    `if [ "$CACHE" = "true" ] && command -v gh > /dev/null; then`,
    `  # the cache key needs the exact version and a cached download is checked`,
    `  # against the release's digest, so look them up (the download step gets`,
    `  # the latest release itself otherwise)`,
    `  release=$(gh release view \${DPRINT_VERSION:+"$DPRINT_VERSION"} --repo dprint/dprint --json tagName,assets \\`,
    `    --jq "[.tagName, (.assets[] | select(.name == \\"$asset\\") | .digest // \\"\\")] | @tsv")`,
    `  IFS=$'\\t' read -r version digest <<< "$release"`,
    `fi`,
    `# releases before 0.57.1 don't have attestations (the latest always does)`,
    `if [ -z "$version" ] || [ "$(printf '%s\\n' 0.57.1 "$version" | sort -V | head -n 1)" = "0.57.1" ]; then`,
    `  attested=true`,
    `else`,
    `  attested=false`,
    `fi`,
    `echo "dprint \${version:-latest} ($asset)"`,
    `echo "version=$version" >> "$GITHUB_OUTPUT"`,
    `echo "asset=$asset" >> "$GITHUB_OUTPUT"`,
    `echo "digest=$digest" >> "$GITHUB_OUTPUT"`,
    `echo "attested=$attested" >> "$GITHUB_OUTPUT"`,
    `# the digest is in the key so a re-uploaded asset gets its own entry`,
    `echo "cache-key=dprint-executable-$RUNNER_OS-$RUNNER_ARCH-$version-\${digest#sha256:}" >> "$GITHUB_OUTPUT"`,
  ],
  outputs: ["version", "asset", "digest", "attested", "cache-key"] as const,
});

// the verified download is cached per version, and on a hit its digest is
// checked against the release's so the attestation verification can be skipped
const downloadDir = concat(expr("runner.temp"), "/dprint-download");
const cacheDownload = cacheEnabled.and(resolve.outputs.digest.notEquals(""));
const restoreDownload = step({
  name: "Restore dprint download",
  id: "restore-download",
  if: cacheDownload,
  uses: "actions/cache/restore@v5",
  with: {
    path: downloadDir,
    key: resolve.outputs["cache-key"],
  },
  outputs: ["cache-hit"] as const,
}).dependsOn(resolve);

const download = step({
  name: "Download dprint",
  id: "download",
  env: {
    VERSION: resolve.outputs.version,
    ASSET: resolve.outputs.asset,
    DIGEST: resolve.outputs.digest,
    ATTESTED: resolve.outputs.attested,
    CACHE_HIT: restoreDownload.outputs["cache-hit"],
    VERIFY_ATTESTATION: inputs["verify-attestation"],
    GH_TOKEN: expr("github.token"),
  },
  run: [
    `download_dir="$RUNNER_TEMP/dprint-download"`,
    `mkdir -p "$download_dir"`,
    `zip="$download_dir/$ASSET"`,
    `# hashed via stdin because sha256sum escapes a file name containing a backslash`,
    `sha256() { if command -v sha256sum > /dev/null; then sha256sum < "$1"; else shasum -a 256 < "$1"; fi | cut -d ' ' -f 1; }`,
    `verify=false`,
    `save=false`,
    `if [ "$CACHE_HIT" = "true" ] && [ -f "$zip" ] && [ "sha256:$(sha256 "$zip")" = "$DIGEST" ]; then`,
    `  echo "Using the cached download of $ASSET for dprint $VERSION, which matches the release's digest."`,
    `else`,
    `  if [ "$CACHE_HIT" = "true" ]; then`,
    `    echo "The cached download of $ASSET doesn't match the release's digest, so downloading it again."`,
    `  fi`,
    `  if command -v gh > /dev/null; then`,
    `    gh release download \${VERSION:+"$VERSION"} --repo dprint/dprint --pattern "$ASSET" --output "$zip" --clobber`,
    `    # the download is cached when the release has a digest to check it against`,
    `    if [ -n "$DIGEST" ]; then save=true; fi`,
    `    if [ "$VERIFY_ATTESTATION" != "true" ]; then`,
    `      echo "Attestation verification is disabled."`,
    `    elif [ "$ATTESTED" = "true" ]; then`,
    `      verify=true`,
    `    else`,
    `      echo "::warning title=dprint::dprint $VERSION predates build provenance attestations, so $ASSET can't be verified. Upgrade to dprint 0.57.1 or later to have the download verified."`,
    `    fi`,
    `  else`,
    `    if [ "$VERIFY_ATTESTATION" = "true" ]; then`,
    `      echo "::warning title=dprint::The GitHub CLI (gh) is not available on this runner, so $ASSET can't be verified. Install it to have the download verified."`,
    `    fi`,
    `    if [ -n "$VERSION" ]; then`,
    `      url="https://github.com/dprint/dprint/releases/download/$VERSION/$ASSET"`,
    `    else`,
    `      url="https://github.com/dprint/dprint/releases/latest/download/$ASSET"`,
    `    fi`,
    `    # curl drops the authorization header on the redirect to the asset host`,
    `    curl -fsSL -H "Authorization: Bearer $GH_TOKEN" --output "$zip" "$url"`,
    `  fi`,
    `  echo "Downloaded $ASSET\${VERSION:+ for dprint $VERSION}."`,
    `fi`,
    `echo "zip=$zip" >> "$GITHUB_OUTPUT"`,
    `echo "verify=$verify" >> "$GITHUB_OUTPUT"`,
    `echo "save=$save" >> "$GITHUB_OUTPUT"`,
  ],
  outputs: ["zip", "verify", "save"] as const,
}).dependsOn(resolve).comesAfter(restoreDownload);

const verify = step({
  name: "Verify dprint attestation",
  if: download.outputs.verify.equals("true"),
  env: {
    ZIP: download.outputs.zip,
    GH_TOKEN: expr("github.token"),
  },
  run: [
    `gh attestation verify "$ZIP" --repo dprint/dprint`,
    `echo "Verified the build provenance attestation of $(basename "$ZIP")."`,
  ],
}).dependsOn(download);

// runs after the verification so a download that fails it is never cached;
// whether to verify is up to the user, and a cached download is checked
// against the release's digest on every hit either way
const saveDownload = step({
  name: "Save dprint download",
  if: cacheDownload.and(download.outputs.save.equals("true")),
  uses: "actions/cache/save@v5",
  with: {
    path: downloadDir,
    key: resolve.outputs["cache-key"],
  },
}).dependsOn(download).comesAfter(verify);

const install = step({
  name: "Install dprint",
  id: "install",
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
    `version=$("$bin_dir/dprint" --version | cut -d ' ' -f 2)`,
    `echo "Installed dprint $version."`,
    `echo "version=$version" >> "$GITHUB_OUTPUT"`,
  ],
  outputs: ["version"] as const,
}).dependsOn(download).comesAfter(verify, saveDownload);

// the hash of the config file the check will use, or of every config file in
// the repo when dprint discovers the config itself (a remote config url can't
// be hashed, so that falls back to the repo's config files too)
const configPath = inputs["config-path"];
const workingDirectory = inputs["working-directory"];
// the config path is relative to the working directory, but hashFiles is
// relative to the workspace
const configPathInWorkspace = workingDirectory.notEquals("")
  .then(concat(workingDirectory, "/", configPath))
  .else(configPath);
const configHash = configPath.notEquals("")
  .and(configPath.startsWith("http").not())
  .then(hashFiles(configPathInWorkspace))
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

// the check runs with --json and the output is turned into readable diffs,
// annotations and the step outputs by a script; dprint before 0.57 rejects
// --json with exit code 10 (argument parsing error), in which case the check
// just runs again without it
const check = step({
  name: "Check formatting",
  id: "check",
  env: {
    WORKING_DIRECTORY: workingDirectory,
    CONFIG_PATH: configPath,
    ANNOTATIONS: inputs.annotations,
    ANNOTATE_SCRIPT: concat(expr("github.action_path"), "/scripts/annotate.mjs"),
  },
  run: [
    `cd "\${WORKING_DIRECTORY:-.}"`,
    `args=(\${CONFIG_PATH:+--config "$CONFIG_PATH"} ${inputs.args})`,
    `if command -v node > /dev/null; then`,
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
  outputs: ["unformatted-count", "unformatted-files"] as const,
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
    "dprint-version": {
      description: "The version of dprint that was installed",
      value: install.outputs.version,
    },
    "cache-matched-key": {
      description: "Key of the cache entry that was restored, if any",
      value: restoreCache.outputs["cache-matched-key"],
    },
    "cache-changed": {
      description: "Whether the check changed the cache and so a new cache entry was saved",
      value: hashCacheAfter.outputs.changed,
    },
    "unformatted-count": {
      description: "The number of files that aren't formatted (requires dprint 0.57+)",
      value: check.outputs["unformatted-count"],
    },
    "unformatted-files": {
      description: "The files that aren't formatted, one per line (requires dprint 0.57+)",
      value: check.outputs["unformatted-files"],
    },
  },
  defaults: { run: { shell: "bash" } },
  steps: [
    resolve,
    restoreDownload,
    download,
    verify,
    saveDownload,
    install,
    restoreCache,
    hashCacheBefore,
    check,
    hashCacheAfter,
    saveCache,
  ],
  branding: { icon: "check-circle", color: "gray-dark" },
}).writeOrLint({
  filePath: new URL("../../action.yml", import.meta.url),
  header: "# GENERATED BY ./.github/workflows/action.ts -- DO NOT DIRECTLY EDIT",
});

if (!isLinting) {
  await $`dprint fmt --log-level=warn action.yml`;
}
