# dprint check action

This action runs `dprint check` on your source code and fails if something is not properly formatted.

## Usage

1. Checkout your repo.
2. Run `dprint/check` action.

```yml
jobs:
  style:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: dprint/check@v2
        with:
          cache: true
```

It's recommended to enable [caching](#caching), which speeds up the check by not downloading and compiling the plugins on every run and by only checking the files that changed since the last run.

If you are using a matrix, most likely you will only want to run it on Linux. For example:

```yml
- uses: dprint/check@v2
  if: runner.os == 'Linux'
  with:
    cache: true
```

### Latest Version

By default, `dprint/check` uses the latest version of dprint.

The dprint executable is downloaded from the [GitHub release](https://github.com/dprint/dprint/releases) and its [build provenance attestation](https://docs.github.com/en/actions/security-for-github-actions/using-artifact-attestations/using-artifact-attestations-to-establish-provenance-for-builds) is verified with `gh attestation verify` before it runs (dprint 0.57.1 and later have attestations).

This takes a few seconds. If that's a concern, use `cache: true` so the verified download is reused across runs.

<details>
<summary>Disabling verification (not recommended)</summary>

Skipping verification means the downloaded executable is not checked against dprint's build provenance, so prefer `cache: true` instead. If you still need to disable it:

```yml
- uses: dprint/check@v2
  with:
    verify-attestation: false
```

</details>

### Specific Version

To use a specific version, specify that with the `dprint-version` input:

```yml
- uses: dprint/check@v2
  with:
    dprint-version: 0.57.4
```

### Config Path

By default, `dprint/check` uses the auto-discovered configuration file.

To use a specific config, specify that with the `config-path` input:

```yml
- uses: dprint/check@v2
  with:
    config-path: dprint-ci.json
```

### Args

To pass additional arguments to `dprint check`, pass them to the `args` input.

```yml
- uses: dprint/check@v2
  with:
    args: --fail-fast
```

### Annotations

When a file isn't formatted, the action emits an error annotation for it, which GitHub shows on the pull request's changed files and in the check summary. The annotation points at the first change and includes the diff. This requires dprint 0.57 or later and `node` on the path (always the case on GitHub-hosted runners); otherwise the action only outputs the diffs to the log. Note that GitHub shows at most 10 error annotations per step, so the log is the complete list.

To disable annotations:

```yml
- uses: dprint/check@v2
  with:
    annotations: false
```

### Caching

Set the `cache` input to `true` to store dprint's cache directory in the GitHub Actions cache between runs:

```yml
- uses: dprint/check@v2
  with:
    cache: true
```

This caches:

- The downloaded and compiled plugins, so they don't need to be downloaded and compiled on every run.
- The [incremental](https://dprint.dev/cli/#incremental) state, so `dprint check` only checks files that changed since the last run that saw them.
- The verified download of the dprint executable, per version, so the attestation verification can be skipped when the cached download matches the release's digest.

## Outputs

| Output              | Description                                                            |
| ------------------- | ---------------------------------------------------------------------- |
| `dprint-version`    | The version of dprint that was installed                               |
| `cache-matched-key` | Key of the cache entry that was restored, if any                       |
| `cache-changed`     | Whether the check changed the cache and so a new cache entry was saved |

## Troubleshooting

### Windows line endings

When running on Windows, you may get a lot of messages like:

```
from D:\a\check\check\README.md:
 | Text differed by line endings.
--
```

This is because git is unfortunately configured in GH actions to check out line endings as CRLF (`\r\n`).

You can fix this by only running the action on Linux as shown above (recommended), or to do the following before checking out the repo:

```yml
- name: Ensure LF line endings for Windows
  run: |
    git config --global core.autocrlf false
    git config --global core.eol lf

- uses: actions/checkout@v7
```
