import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { fromFileUrl } from "jsr:@std/path@1";

const scriptPath = fromFileUrl(new URL("./annotate.mjs", import.meta.url));

async function runAnnotate(workspace: string, entries: Record<string, unknown>[], env: Record<string, string> = {}) {
  const jsonlPath = `${workspace}/dprint-check.jsonl`;
  await Deno.writeTextFile(jsonlPath, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  const outputsPath = `${workspace}/github-output`;
  await Deno.writeTextFile(outputsPath, "");
  const output = await new Deno.Command("node", {
    args: [scriptPath, jsonlPath],
    env: { GITHUB_WORKSPACE: workspace, GITHUB_OUTPUT: outputsPath, RUNNER_OS: "Linux", ...env },
  }).output();
  return {
    code: output.code,
    stdout: new TextDecoder().decode(output.stdout),
    stderr: new TextDecoder().decode(output.stderr),
    // the multiline delimiter is random, so replace it for comparison
    outputs: (await Deno.readTextFile(outputsPath)).replaceAll(/dprint-check-[0-9a-f-]+/g, "DELIMITER"),
  };
}

Deno.test("annotates each file at the first change and prints the diffs", async () => {
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
      "::error file=src/bad.md,line=4,title=dprint,endLine=5::File is not formatted. Run `dprint fmt` to fix.%0A%0A@@ -4,2 +4,2 @@%0A-*   a%0A-*  b%0A+- a%0A+- b",
      "from bad.json:",
      "--- original",
      "+++ formatted",
      "@@ -1 +1 @@",
      "-{\"a\":1}",
      "+{ \"a\": 1 }",
      "--",
      "::error file=bad.json,line=1,title=dprint::File is not formatted. Run `dprint fmt` to fix.%0A%0A@@ -1 +1 @@%0A-{\"a\":1}%0A+{ \"a\": 1 }",
      "Found 2 not formatted files. Run dprint fmt to fix.",
      "",
    ]);
    assertEquals(
      result.outputs,
      "unformatted-count=2\nunformatted-files<<DELIMITER\nsrc/bad.md\nbad.json\nDELIMITER\n",
    );
  } finally {
    await Deno.remove(workspace, { recursive: true });
  }
});

Deno.test("records the outputs without annotations when they're disabled", async () => {
  const workspace = await Deno.makeTempDir();
  try {
    const result = await runAnnotate(workspace, [{
      file: `${workspace}/bad.json`,
      diff: "--- original\n+++ formatted\n@@ -1 +1 @@\n-{\"a\":1}\n+{ \"a\": 1 }\n",
    }], { ANNOTATIONS: "false" });
    assertEquals(result.stderr, "");
    assertEquals(result.code, 0);
    assertEquals(result.stdout.split("\n"), [
      "from bad.json:",
      "--- original",
      "+++ formatted",
      "@@ -1 +1 @@",
      "-{\"a\":1}",
      "+{ \"a\": 1 }",
      "--",
      "Found 1 not formatted file. Run dprint fmt to fix.",
      "",
    ]);
    assertEquals(result.outputs, "unformatted-count=1\nunformatted-files<<DELIMITER\nbad.json\nDELIMITER\n");
  } finally {
    await Deno.remove(workspace, { recursive: true });
  }
});

Deno.test("annotates only the changed lines since the surrounding lines are already visible", async () => {
  const workspace = await Deno.makeTempDir();
  try {
    const result = await runAnnotate(workspace, [{
      file: `${workspace}/context.md`,
      diff: "--- original\n+++ formatted\n@@ -8,7 +8,7 @@\n \n a\n \n-##   Title\n+## Title\n \n b\n",
    }, {
      // a hunk can have several changes separated by context lines
      file: `${workspace}/two-changes.md`,
      diff: "--- original\n+++ formatted\n@@ -1,6 +1,6 @@\n a\n-b \n+b\n c\n d\n e\n-f \n+f\n",
    }, {
      // an insertion doesn't cover any original lines, so it points at the line before it
      file: `${workspace}/insertion.md`,
      diff: "--- original\n+++ formatted\n@@ -1,2 +1,3 @@\n a\n+b\n c\n",
    }]);
    assertEquals(result.stderr, "");
    assertEquals(result.code, 0);
    assertStringIncludes(
      result.stdout,
      "::error file=context.md,line=11,title=dprint::File is not formatted. Run `dprint fmt` to fix.%0A%0A@@ -11 +11 @@%0A-##   Title%0A+## Title\n",
    );
    assertStringIncludes(
      result.stdout,
      "::error file=two-changes.md,line=2,title=dprint::File is not formatted. Run `dprint fmt` to fix.%0A%0A@@ -2 +2 @@%0A-b %0A+b%0A@@ -6 +6 @@%0A-f %0A+f\n",
    );
    assertStringIncludes(
      result.stdout,
      "::error file=insertion.md,line=1,title=dprint::File is not formatted. Run `dprint fmt` to fix.%0A%0A@@ -1,0 +2 @@%0A+b\n",
    );
  } finally {
    await Deno.remove(workspace, { recursive: true });
  }
});

Deno.test("truncates a long diff since the full diff is in the log", async () => {
  const workspace = await Deno.makeTempDir();
  try {
    const result = await runAnnotate(workspace, [{
      // stops at a change boundary so a removal isn't shown without its replacement
      file: `${workspace}/two-changes.md`,
      diff:
        "--- original\n+++ formatted\n@@ -1,12 +1,12 @@\n-a \n-b \n-c \n+a\n+b\n+c\n d\n e\n f\n-g \n-h \n-i \n+g\n+h\n+i\n",
    }, {
      // a change that's too long on its own is cut short
      file: `${workspace}/one-change.md`,
      diff: "--- original\n+++ formatted\n@@ -1,6 +1,6 @@\n-a \n-b \n-c \n-d \n-e \n-f \n+a\n+b\n+c\n+d\n+e\n+f\n",
    }]);
    assertEquals(result.stderr, "");
    assertEquals(result.code, 0);
    assertStringIncludes(
      result.stdout,
      "::error file=two-changes.md,line=1,title=dprint,endLine=3::File is not formatted. Run `dprint fmt` to fix.%0A%0A@@ -1,3 +1,3 @@%0A-a %0A-b %0A-c %0A+a%0A+b%0A+c%0A(truncated, see the log for the full diff)\n",
    );
    assertStringIncludes(
      result.stdout,
      "::error file=one-change.md,line=1,title=dprint,endLine=6::File is not formatted. Run `dprint fmt` to fix.%0A%0A@@ -1,6 +1,6 @@%0A-a %0A-b %0A-c %0A-d %0A-e %0A-f %0A+a%0A+b%0A+c%0A(truncated, see the log for the full diff)\n",
    );
  } finally {
    await Deno.remove(workspace, { recursive: true });
  }
});

Deno.test("lists the remaining files in the last annotation when there are more than github shows", async () => {
  const workspace = await Deno.makeTempDir();
  const fileEntries = (count: number) =>
    Array.from({ length: count }, (_, i) => ({
      file: `${workspace}/file${i + 1}.json`,
      diff: "--- original\n+++ formatted\n@@ -1 +1 @@\n-{\"a\":1}\n+{ \"a\": 1 }\n",
    }));
  const countAnnotations = (stdout: string) => stdout.split("\n").filter((line) => line.startsWith("::error ")).length;
  try {
    const tooMany = await runAnnotate(workspace, fileEntries(12));
    assertEquals(tooMany.stderr, "");
    assertEquals(tooMany.code, 0);
    assertEquals(countAnnotations(tooMany.stdout), 10);
    assertStringIncludes(tooMany.stdout, "::error file=file9.json,line=1,title=dprint::");
    assertEquals(tooMany.stdout.includes("::error file=file10.json"), false);
    assertStringIncludes(
      tooMany.stdout,
      "::error title=dprint::3 more files are not formatted. Run `dprint fmt` to fix.%0A%0Afile10.json%0Afile11.json%0Afile12.json\n"
        + "Found 12 not formatted files. Run dprint fmt to fix.\n",
    );

    // the limit itself still annotates every file
    const atLimit = await runAnnotate(workspace, fileEntries(10));
    assertEquals(atLimit.code, 0);
    assertEquals(countAnnotations(atLimit.stdout), 10);
    assertStringIncludes(atLimit.stdout, "::error file=file10.json,line=1,title=dprint::");
    assertEquals(atLimit.stdout.includes("more files are not formatted"), false);
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
      "::error file=100%25/a%2Cb%3Ac.json,line=1,title=dprint::File is not formatted. Run `dprint fmt` to fix.%0A%0A@@ -1 +1 @@%0A-{\"ok\":true}\\r%0A+{ \"ok\": true }",
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
      "::error file=missing-newline.md,line=1,title=dprint::File is not formatted. Run `dprint fmt` to fix.%0A%0A@@ -1 +1 @@%0A-a%0A\\ No newline at end of file%0A+a",
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
    }], { RUNNER_OS: "Windows" });
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
    assertStringIncludes(
      result.stdout,
      "::error file=empty.json,line=1,title=dprint::File is not formatted. Run `dprint fmt` to fix.%0A%0A@@ -0,0 +1 @@%0A+{}\n",
    );
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
    assertEquals(result.outputs, "unformatted-count=0\nunformatted-files<<DELIMITER\nDELIMITER\n");
  } finally {
    await Deno.remove(workspace, { recursive: true });
  }
});
