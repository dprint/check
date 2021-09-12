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
      - uses: actions/checkout@v2

      - uses: dprint/check@v2.0
```

### Latest Version

By default, `dprint/check` uses the latest version of dprint.

### Specific Version

To use a specific version, specify that with the `dprint-version` input:

```yml
- uses: dprint/check@v2.0
  with:
    dprint-version: 0.17.0
```
