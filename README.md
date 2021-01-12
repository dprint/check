# dprint check action

This action runs `dprint check` on your source code and fails the build if something is not properly formatted.

## Usage

```yml
jobs:
  style:
    runs-on: ubuntu-latest
    steps:
      - uses: dprint/check@v1
```
