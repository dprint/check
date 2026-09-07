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
  const changes = entry.diff == null ? undefined : parseChanges(entry.diff);
  // a diff that only changes line endings is every line of the file, so
  // summarize it like dprint's default output does
  const lineEndings = changes == null ? undefined : getLineEndingsOnlyChange(changes);
  console.log(`from ${relativePath}:`);
  console.log(describeDiff(entry.diff, lineEndings));
  console.log("--");
  console.log(annotation(relativePath, changes, lineEndings));
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
function annotation(relativePath, changes, lineEndings) {
  // the whole file differs when only the line endings do, so point at the top
  // of it rather than highlighting every line
  const range = changes == null || lineEndings != null ? { line: 1, endLine: 1 } : changeRange(changes[0]);
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
  } else if (changes != null && changes.length > 0) {
    // the annotation is shown beside the file, so the surrounding lines are
    // already visible and only the changed lines are worth repeating
    message += "\n\n" + truncate(makePrintable(changes.map(formatChange).join("\n")), MAX_ANNOTATION_MESSAGE_LENGTH);
  }
  return `::error ${propertiesText}::${escapeMessage(message)}`;
}

/**
 * Gets the range of lines in the original file that a change covers. An
 * insertion doesn't cover any, so it points at the line it comes after.
 */
function changeRange(change) {
  if (change == null) {
    return { line: 1, endLine: 1 };
  }
  if (change.oldCount === 0) {
    const line = Math.max(change.oldStart - 1, 1);
    return { line, endLine: line };
  }
  return { line: change.oldStart, endLine: change.oldStart + change.oldCount - 1 };
}

/** Formats a change as a unified diff hunk without context lines, like `diff -U0` does. */
function formatChange(change) {
  const header = `@@ -${hunkRange(change.oldStart, change.oldCount)} +${
    hunkRange(change.newStart, change.newCount)
  } @@`;
  return [header, ...change.lines].join("\n");
}

function hunkRange(start, count) {
  if (count === 1) {
    return `${start}`;
  }
  // an empty range is written as the line it comes after
  return `${count === 0 ? start - 1 : start},${count}`;
}

/**
 * Splits a unified diff into its changes, which are the consecutive runs of
 * removed and added lines, along with where they start on each side.
 */
function parseChanges(diff) {
  const changes = [];
  let current;
  let inHunk = false;
  let oldLine = 0;
  let newLine = 0;
  for (const line of diff.split("\n")) {
    const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunk != null) {
      inHunk = true;
      current = undefined;
      oldLine = hunkStartLine(hunk[1], hunk[2]);
      newLine = hunkStartLine(hunk[3], hunk[4]);
      continue;
    }
    if (!inHunk) {
      continue;
    }
    const sign = line[0];
    if (sign === "-" || sign === "+") {
      if (current == null) {
        current = { oldStart: oldLine, oldCount: 0, newStart: newLine, newCount: 0, lines: [] };
        changes.push(current);
      }
      current.lines.push(line);
      if (sign === "-") {
        current.oldCount++;
        oldLine++;
      } else {
        current.newCount++;
        newLine++;
      }
    } else if (sign === "\\") {
      // a "no newline at end of file" marker belongs to the line before it
      current?.lines.push(line);
    } else {
      // a context line ends the current change
      current = undefined;
      oldLine++;
      newLine++;
    }
  }
  return changes;
}

/** Gets the first line of a hunk, where an empty range is written as the line it comes after. */
function hunkStartLine(start, count) {
  const line = Number(start);
  return count === "0" ? line + 1 : line;
}

/**
 * Gets the line ending the original file had when a diff only changes line
 * endings, which is found by comparing the removed and added lines of each
 * change without carriage returns. Returns `undefined` otherwise.
 */
function getLineEndingsOnlyChange(changes) {
  let originalHasCarriageReturn = false;
  for (const change of changes) {
    const oldLines = [];
    const newLines = [];
    // the side the previous line was added to, so a "no newline at end of
    // file" marker can be applied to it
    let previousSide;
    for (const line of change.lines) {
      if (line.startsWith("\\")) {
        if (previousSide != null) {
          previousSide[previousSide.length - 1] += "<no newline>";
        }
        continue;
      }
      previousSide = line[0] === "-" ? oldLines : newLines;
      if (previousSide === oldLines && line.endsWith("\r")) {
        originalHasCarriageReturn = true;
      }
      previousSide.push(line.slice(1).replace(/\r$/, ""));
    }
    const isOnlyLineEndings = oldLines.length === newLines.length && oldLines.every((line, i) => line === newLines[i]);
    if (!isOnlyLineEndings) {
      return undefined;
    }
  }
  return { original: originalHasCarriageReturn ? "crlf" : "lf" };
}

function toRelativePath(filePath, workspace) {
  const relativePath = path.relative(workspace, filePath);
  const isOutside = relativePath === ".." || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath);
  return (isOutside ? filePath : relativePath).replaceAll("\\", "/");
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
