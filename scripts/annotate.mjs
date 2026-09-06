// Prints the output of `dprint check --json` in a readable form and emits a
// GitHub Actions error annotation for each file that isn't formatted.
//
// Usage: node annotate.mjs <path to the newline delimited json output>
import fs from "node:fs";
import path from "node:path";

const MAX_ANNOTATION_MESSAGE_LENGTH = 4000;
const LINE_ENDINGS_MESSAGE = "Text differed by line endings.";
const WINDOWS_LINE_ENDINGS_HINT =
  "Git on Windows runners checks out files with CRLF line endings, so consider only running this action on Linux: https://github.com/dprint/check#windows-line-endings";

const jsonlPath = process.argv[2];
if (jsonlPath == null) {
  console.error("Expected the path to the dprint check --json output.");
  process.exit(1);
}
const workspace = process.env.GITHUB_WORKSPACE ?? process.cwd();
const entries = fs.readFileSync(jsonlPath, "utf8")
  .split("\n")
  .filter((line) => line.trim() !== "")
  .flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      // dprint may have been killed mid-output, so don't let a partial line
      // hide the diffs that were output and dprint's exit code
      console.error(`Skipping unparsable dprint output: ${line}`);
      return [];
    }
  });

for (const entry of entries) {
  const relativePath = toRelativePath(entry.file, workspace);
  // a diff that only changes line endings is every line of the file, so
  // summarize it like dprint's default output does
  const lineEndings = entry.diff == null ? undefined : getLineEndingsOnlyChange(entry.diff);
  console.log(`from ${relativePath}:`);
  console.log(describeDiff(entry.diff, lineEndings));
  console.log("--");
  console.log(annotation(relativePath, entry.diff, lineEndings));
}

if (entries.length > 0) {
  const suffix = entries.length === 1 ? "file" : "files";
  console.log(`Found ${entries.length} not formatted ${suffix}. Run dprint fmt to fix.`);
}

/** Gets the diff in a readable form, or a short message when there's nothing useful to show. */
function describeDiff(diff, lineEndings) {
  if (diff == null) {
    return "File is not valid utf-8.";
  }
  return lineEndings != null ? LINE_ENDINGS_MESSAGE : makePrintable(diff);
}

/** Builds the `::error` workflow command for a file that isn't formatted. */
function annotation(relativePath, diff, lineEndings) {
  // the whole file differs when only the line endings do, so point at the top
  // of it rather than highlighting every line
  const range = lineEndings != null ? { line: 1, endLine: 1 } : firstHunkRange(diff);
  const properties = { file: relativePath, line: range.line, title: "dprint" };
  if (range.endLine !== range.line) {
    properties.endLine = range.endLine;
  }
  const propertiesText = Object.entries(properties)
    .map(([key, value]) => `${key}=${escapeProperty(String(value))}`)
    .join(",");
  let message = "File is not formatted. Run `dprint fmt` to fix.";
  if (lineEndings != null) {
    message += "\n" + LINE_ENDINGS_MESSAGE;
    if (lineEndings.original === "crlf" && process.env.RUNNER_OS === "Windows") {
      message += " " + WINDOWS_LINE_ENDINGS_HINT;
    }
  } else if (diff != null) {
    message += "\n" + truncate(makePrintable(stripDiffHeader(diff)), MAX_ANNOTATION_MESSAGE_LENGTH);
  }
  return `::error ${propertiesText}::${escapeMessage(message)}`;
}

/**
 * Gets the range of lines in the original file covered by the first hunk of
 * a unified diff, falling back to the first line when there's no hunk.
 */
function firstHunkRange(diff) {
  const match = diff == null ? null : /^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@/m.exec(diff);
  if (match == null) {
    return { line: 1, endLine: 1 };
  }
  // an empty original file has a hunk starting at line 0
  const line = Math.max(Number(match[1]), 1);
  // a count of zero means lines are only inserted after this line
  const count = Math.max(match[2] == null ? 1 : Number(match[2]), 1);
  return { line, endLine: line + count - 1 };
}

/**
 * Gets the line ending the original file had when a unified diff only changes
 * line endings, which is found by rebuilding both sides of the diff and
 * comparing them without carriage returns. Returns `undefined` otherwise.
 */
function getLineEndingsOnlyChange(diff) {
  const oldLines = [];
  const newLines = [];
  let originalHasCarriageReturn = false;
  // the sides the previous line was added to, so a "no newline at end of
  // file" marker can be applied to it
  let previousSides = [];
  let inHunk = false;
  for (const line of diff.split("\n")) {
    if (line.startsWith("@@")) {
      inHunk = true;
      continue;
    }
    if (!inHunk) {
      continue;
    }
    if (line.startsWith("\\")) {
      for (const side of previousSides) {
        side[side.length - 1] += "<no newline>";
      }
      continue;
    }
    const sign = line[0];
    previousSides = sign === "-" ? [oldLines] : sign === "+" ? [newLines] : sign === " " ? [oldLines, newLines] : [];
    if (sign === "-" && line.endsWith("\r")) {
      originalHasCarriageReturn = true;
    }
    for (const side of previousSides) {
      side.push(line.slice(1).replace(/\r$/, ""));
    }
  }
  const isOnlyLineEndings = oldLines.length === newLines.length && oldLines.every((line, i) => line === newLines[i]);
  return isOnlyLineEndings ? { original: originalHasCarriageReturn ? "crlf" : "lf" } : undefined;
}

function toRelativePath(filePath, workspace) {
  const relativePath = path.relative(workspace, filePath);
  const isOutside = relativePath === ".." || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath);
  return (isOutside ? filePath : relativePath).replaceAll("\\", "/");
}

/** Removes the `--- original` and `+++ formatted` lines. */
function stripDiffHeader(diff) {
  return diff.split("\n").filter((line) => !/^(---|\+\+\+) /.test(line)).join("\n");
}

/** Makes carriage returns visible so a line ending difference is readable. */
function makePrintable(text) {
  return text.replaceAll("\r", "\\r").trimEnd();
}

function truncate(text, maxLength) {
  return text.length <= maxLength ? text : `${text.slice(0, maxLength)}\n(truncated)`;
}

function escapeProperty(value) {
  return value
    .replaceAll("%", "%25")
    .replaceAll("\r", "%0D")
    .replaceAll("\n", "%0A")
    .replaceAll(":", "%3A")
    .replaceAll(",", "%2C");
}

function escapeMessage(value) {
  return value
    .replaceAll("%", "%25")
    .replaceAll("\r", "%0D")
    .replaceAll("\n", "%0A");
}
