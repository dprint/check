import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { fromFileUrl } from "jsr:@std/path@1";

const scriptPath = fromFileUrl(new URL("./annotate.mjs", import.meta.url));

async function runAnnotate(workspace: string, entries: Record<string, unknown>[]) {
  const jsonlPath = `${workspace}/dprint-check.jsonl`;
  await Deno.writeTextFile(jsonlPath, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  const output = await new Deno.Command("node", {
    args: [scriptPath, jsonlPath],
    env: { GITHUB_WORKSPACE: workspace },
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
      diff: "--- original\n+++ formatted\n@@ -1 +1 @@\n-{ \"ok\": true }\r\n+{ \"ok\": true }\n",
    }]);
    assertEquals(result.code, 0);
    assertStringIncludes(result.stdout, "-{ \"ok\": true }\\r\n+{ \"ok\": true }\n");
    assertStringIncludes(
      result.stdout,
      "::error file=100%25/a%2Cb%3Ac.json,line=1,title=dprint::File is not formatted. Run `dprint fmt` to fix.%0A@@ -1 +1 @@%0A-{ \"ok\": true }\\r%0A+{ \"ok\": true }",
    );
    assertStringIncludes(result.stdout, "Found 1 not formatted file.");
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
