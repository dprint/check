// Prints the output of `dprint check --json` in a readable form and emits a
// GitHub Actions error annotation for each file that isn't formatted.
//
// Usage: node annotate.mjs <path to the newline delimited json output>
import fs from "node:fs";
import path from "node:path";

const MAX_ANNOTATION_MESSAGE_LENGTH = 4000;

const jsonlPath = process.argv[2];
if (jsonlPath == null) {
  console.error("Expected the path to the dprint check --json output.");
  process.exit(1);
}
const workspace = process.env.GITHUB_WORKSPACE ?? process.cwd();
const entries = fs.readFileSync(jsonlPath, "utf8")
  .split("\n")
  .filter((line) => line.trim() !== "")
  .map((line) => JSON.parse(line));

for (const entry of entries) {
  const relativePath = toRelativePath(entry.file, workspace);
  const diff = entry.diff == null ? "File is not valid utf-8." : makePrintable(entry.diff);
  console.log(`from ${relativePath}:`);
  console.log(diff);
  console.log("--");
  console.log(annotation(relativePath, entry.diff));
}

if (entries.length > 0) {
  const suffix = entries.length === 1 ? "file" : "files";
  console.log(`Found ${entries.length} not formatted ${suffix}. Run dprint fmt to fix.`);
}

/** Builds the `::error` workflow command for a file that isn't formatted. */
function annotation(relativePath, diff) {
  const range = firstHunkRange(diff);
  const properties = { file: relativePath, line: range.line, title: "dprint" };
  if (range.endLine !== range.line) {
    properties.endLine = range.endLine;
  }
  const propertiesText = Object.entries(properties)
    .map(([key, value]) => `${key}=${escapeProperty(String(value))}`)
    .join(",");
  let message = "File is not formatted. Run `dprint fmt` to fix.";
  if (diff != null) {
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
  const line = Number(match[1]);
  // a count of zero means lines are only inserted after this line
  const count = Math.max(match[2] == null ? 1 : Number(match[2]), 1);
  return { line, endLine: line + count - 1 };
}

function toRelativePath(filePath, workspace) {
  const relativePath = path.relative(workspace, filePath);
  const result = relativePath.startsWith("..") ? filePath : relativePath;
  return result.replaceAll("\\", "/");
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
