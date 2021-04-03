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

      - uses: dprint/check@v1.2
```
