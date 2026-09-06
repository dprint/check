import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { fromFileUrl } from "jsr:@std/path@1";

const scriptPath = fromFileUrl(new URL("./annotate.mjs", import.meta.url));

async function runAnnotate(workspace: string, entries: Record<string, unknown>[], runnerOs = "Linux") {
  const jsonlPath = `${workspace}/dprint-check.jsonl`;
  await Deno.writeTextFile(jsonlPath, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  const output = await new Deno.Command("node", {
    args: [scriptPath, jsonlPath],
    env: { GITHUB_WORKSPACE: workspace, RUNNER_OS: runnerOs },
  }).output();
  return {
    code: output.code,
    stdout: new TextDecoder().decode(output.stdout),
    stderr: new TextDecoder().decode(output.stderr),
  };
}

Deno.test("annotates each file at the first hunk and prints the diffs", async () => {
  const workspace = await Deno.makeTempDir();
  try {
    const result = await runAnnotate(workspace, [{
      file: `${workspace}/src/bad.md`,
      diff: "--- original\n+++ formatted\n@@ -3,4 +3,2 @@\n # T\n-*   a\n-*  b\n+- a\n+- b\n",
    }, {
      // a single line hunk has no count
      file: `${workspace}/bad.json`,
      diff: "--- original\n+++ formatted\n@@ -1 +1 @@\n-{\"a\":1}\n+{ \"a\": 1 }\n",
    }]);
    assertEquals(result.stderr, "");
    assertEquals(result.code, 0);
    assertEquals(result.stdout.split("\n"), [
      "from src/bad.md:",
      "--- original",
      "+++ formatted",
      "@@ -3,4 +3,2 @@",
      " # T",
      "-*   a",
      "-*  b",
      "+- a",
      "+- b",
      "--",
      "::error file=src/bad.md,line=3,title=dprint,endLine=6::File is not formatted. Run `dprint fmt` to fix.%0A@@ -3,4 +3,2 @@%0A # T%0A-*   a%0A-*  b%0A+- a%0A+- b",
      "from bad.json:",
      "--- original",
      "+++ formatted",
      "@@ -1 +1 @@",
      "-{\"a\":1}",
      "+{ \"a\": 1 }",
      "--",
      "::error file=bad.json,line=1,title=dprint::File is not formatted. Run `dprint fmt` to fix.%0A@@ -1 +1 @@%0A-{\"a\":1}%0A+{ \"a\": 1 }",
      "Found 2 not formatted files. Run dprint fmt to fix.",
      "",
    ]);
  } finally {
    await Deno.remove(workspace, { recursive: true });
  }
});

Deno.test("makes carriage returns visible and escapes the annotation", async () => {
  const workspace = await Deno.makeTempDir();
  try {
    const result = await runAnnotate(workspace, [{
      file: `${workspace}/100%/a,b:c.json`,
      diff: "--- original\n+++ formatted\n@@ -1 +1 @@\n-{\"ok\":true}\r\n+{ \"ok\": true }\n",
    }]);
    assertEquals(result.code, 0);
    assertStringIncludes(result.stdout, "-{\"ok\":true}\\r\n+{ \"ok\": true }\n");
    assertStringIncludes(
      result.stdout,
      "::error file=100%25/a%2Cb%3Ac.json,line=1,title=dprint::File is not formatted. Run `dprint fmt` to fix.%0A@@ -1 +1 @@%0A-{\"ok\":true}\\r%0A+{ \"ok\": true }",
    );
    assertStringIncludes(result.stdout, "Found 1 not formatted file.");
  } finally {
    await Deno.remove(workspace, { recursive: true });
  }
});

Deno.test("summarizes a diff that only changes line endings", async () => {
  const workspace = await Deno.makeTempDir();
  try {
    const result = await runAnnotate(workspace, [{
      file: `${workspace}/crlf.md`,
      diff: "--- original\n+++ formatted\n@@ -1,3 +1,3 @@\n-# Title\r\n-\r\n-Some text.\r\n+# Title\n+\n+Some text.\n",
    }, {
      // a file without a final newline on both sides still only differs by line endings
      file: `${workspace}/no-newline.md`,
      diff:
        "--- original\n+++ formatted\n@@ -1,2 +1,2 @@\n-a\r\n-b\n\\ No newline at end of file\n+a\n+b\n\\ No newline at end of file\n",
    }, {
      // adding a final newline is a real change, not a line ending one
      file: `${workspace}/missing-newline.md`,
      diff: "--- original\n+++ formatted\n@@ -1 +1 @@\n-a\n\\ No newline at end of file\n+a\n",
    }]);
    assertEquals(result.stderr, "");
    assertEquals(result.code, 0);
    assertEquals(result.stdout.split("\n"), [
      "from crlf.md:",
      "Text differed by line endings.",
      "--",
      "::error file=crlf.md,line=1,title=dprint::File is not formatted. Run `dprint fmt` to fix.%0AText differed by line endings.",
      "from no-newline.md:",
      "Text differed by line endings.",
      "--",
      "::error file=no-newline.md,line=1,title=dprint::File is not formatted. Run `dprint fmt` to fix.%0AText differed by line endings.",
      "from missing-newline.md:",
      "--- original",
      "+++ formatted",
      "@@ -1 +1 @@",
      "-a",
      "\\ No newline at end of file",
      "+a",
      "--",
      "::error file=missing-newline.md,line=1,title=dprint::File is not formatted. Run `dprint fmt` to fix.%0A@@ -1 +1 @@%0A-a%0A\\ No newline at end of file%0A+a",
      "Found 3 not formatted files. Run dprint fmt to fix.",
      "",
    ]);
  } finally {
    await Deno.remove(workspace, { recursive: true });
  }
});

Deno.test("recommends only running on linux when a windows checkout has crlf line endings", async () => {
  const workspace = await Deno.makeTempDir();
  try {
    const result = await runAnnotate(workspace, [{
      file: `${workspace}/crlf.md`,
      diff: "--- original\n+++ formatted\n@@ -1 +1 @@\n-a\r\n+a\n",
    }, {
      // the config wants crlf, so the runner's checkout isn't the problem
      file: `${workspace}/lf.md`,
      diff: "--- original\n+++ formatted\n@@ -1 +1 @@\n-a\n+a\r\n",
    }], "Windows");
    assertEquals(result.stderr, "");
    assertEquals(result.code, 0);
    assertStringIncludes(
      result.stdout,
      "::error file=crlf.md,line=1,title=dprint::File is not formatted. Run `dprint fmt` to fix.%0AText differed by line endings. Git on Windows runners checks out files with CRLF line endings, so consider only running this action on Linux: https://github.com/dprint/check#windows-line-endings\n",
    );
    assertStringIncludes(
      result.stdout,
      "::error file=lf.md,line=1,title=dprint::File is not formatted. Run `dprint fmt` to fix.%0AText differed by line endings.\n",
    );
  } finally {
    await Deno.remove(workspace, { recursive: true });
  }
});

Deno.test("handles a file that isn't valid utf-8 and files outside the workspace", async () => {
  const workspace = await Deno.makeTempDir();
  const elsewhere = await Deno.makeTempDir();
  try {
    const result = await runAnnotate(workspace, [{ file: `${elsewhere}/bad.json`, diff: null }]);
    assertEquals(result.code, 0);
    // a file outside the workspace keeps its absolute path
    const filePath = `${elsewhere.replaceAll("\\", "/")}/bad.json`;
    assertEquals(result.stdout.split("\n"), [
      `from ${filePath}:`,
      "File is not valid utf-8.",
      "--",
      `::error file=${
        filePath.replaceAll(":", "%3A")
      },line=1,title=dprint::File is not formatted. Run \`dprint fmt\` to fix.`,
      "Found 1 not formatted file. Run dprint fmt to fix.",
      "",
    ]);
  } finally {
    await Deno.remove(workspace, { recursive: true });
    await Deno.remove(elsewhere, { recursive: true });
  }
});

Deno.test("clamps the line to 1 for an empty original file", async () => {
  const workspace = await Deno.makeTempDir();
  try {
    const result = await runAnnotate(workspace, [{
      file: `${workspace}/empty.json`,
      diff: "--- original\n+++ formatted\n@@ -0,0 +1 @@\n+{}\n",
    }]);
    assertEquals(result.code, 0);
    assertStringIncludes(result.stdout, "::error file=empty.json,line=1,title=dprint::");
  } finally {
    await Deno.remove(workspace, { recursive: true });
  }
});

Deno.test("skips a partial trailing line", async () => {
  const workspace = await Deno.makeTempDir();
  try {
    const jsonlPath = `${workspace}/dprint-check.jsonl`;
    await Deno.writeTextFile(
      jsonlPath,
      JSON.stringify({ file: `${workspace}/bad.json`, diff: null }) + "\n" + "{\"file\": \"partial",
    );
    const output = await new Deno.Command("node", {
      args: [scriptPath, jsonlPath],
      env: { GITHUB_WORKSPACE: workspace },
    }).output();
    assertEquals(output.code, 0);
    assertStringIncludes(new TextDecoder().decode(output.stdout), "::error file=bad.json,line=1,title=dprint::");
    assertStringIncludes(new TextDecoder().decode(output.stderr), "Skipping unparsable dprint output");
  } finally {
    await Deno.remove(workspace, { recursive: true });
  }
});

Deno.test("prints nothing for empty output", async () => {
  const workspace = await Deno.makeTempDir();
  try {
    const result = await runAnnotate(workspace, []);
    assertEquals(result.code, 0);
    assertEquals(result.stdout, "");
  } finally {
    await Deno.remove(workspace, { recursive: true });
  }
});
