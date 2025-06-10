# dprint check action

This action runs `dprint check` on your source code and fails the build if something is not properly formatted.

## Usage

1. Checkout your repo.
2. Run `dprint/check` action.

```yml
jobs:
  style:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: dprint/check@v2.3
```

If you are using a matrix, most likely you will only want to run it only on Linux. For example:

```yml
- uses: dprint/check@v2.3
  if: runner.os == 'Linux'
```

### Latest Version

By default, `dprint/check` uses the latest version of dprint.

### Specific Version

To use a specific version, specify that with the `dprint-version` input:

```yml
- uses: dprint/check@v2.3
  with:
    dprint-version: 0.30.3
```

### Config Path

By default, `dprint/check` uses the auto-discovered configuration file.

### Specific Config

To use a specific config, specify that with the `config-path` input:

```yml
- uses: dprint/check@v2.3
  with:
    config-path: dprint-ci.json
```

### Args

To pass additional arguments to `dprint check`, pass them to the `args` input. E.g. to only check changed files:

```yml
- name: Get changed files
  id: changed-files
  uses: tj-actions/changed-files@v45
- uses: dprint/check@v2.3
  with:
    args: >-
      --allow-no-files
      ${{ steps.changed-files.outputs.all_changed_files }}
```

## Troubleshooting

### Windows line endings

When running on Windows, you may get a lot of messages like:

```
from D:\a\check\check\README.md:
 | Text differed by line endings.
--
```

This is because unfortunately git is configured in GH actions to check out line endings as CRLF (`\r\n`).

You can fix this by only running the action on Linux as shown above (recommended), or to do the following before checking out the repo:

```yml
- name: Ensure LF line endings for Windows
  run: |
    git config --global core.autocrlf false
    git config --global core.eol lf

- uses: actions/checkout@v4
```
