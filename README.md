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
      - uses: actions/checkout@v3

      - uses: dprint/check@v2.1
```

If you are using a matrix, most likely you will only want to run it on one of them:

```yml
- name: Check format
  if: contains(matrix.os, 'ubuntu')
  uses: dprint/check@v2.1
```

### Latest Version

By default, `dprint/check` uses the latest version of dprint.

### Specific Version

To use a specific version, specify that with the `dprint-version` input:

```yml
- uses: dprint/check@v2.1
  with:
    dprint-version: 0.30.3
```
