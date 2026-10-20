#!/usr/bin/env node
// Smoke test: spawn dist/index.js over stdio, list tools and call list_chats.
// Prints only counts and field names. Never prints message or contact contents.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const serverPath = join(here, "..", "dist", "index.js");

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverPath],
  env: { ...process.env },
  stderr: "pipe",
});

const client = new Client({ name: "imessage-mcp-smoke", version: "0.0.0" });

let failed = false;
const fail = (msg) => {
  failed = true;
  console.log(`FAIL: ${msg}`);
};

try {
  await client.connect(transport);

  const { tools } = await client.listTools();
  console.log(`tools: ${tools.length}`);
  for (const t of tools) {
    const ro = t.annotations?.readOnlyHint === true ? "readOnly" : "NOT-readOnly";
    console.log(`  - ${t.name} (${ro}, openWorld=${t.annotations?.openWorldHint})`);
    if (t.annotations?.readOnlyHint !== true) fail(`${t.name} is not marked readOnlyHint`);
  }

  const result = await client.callTool({ name: "list_chats", arguments: { limit: 3 } });
  const text = result.content?.find((c) => c.type === "text")?.text ?? "";

  if (result.isError) {
    // Print only the first line of the error, which is the diagnostic, not data.
    console.log(`list_chats: isError=true`);
    console.log(`  ${text.split("\n")[0]}`);
  } else {
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      fail("list_chats returned non-JSON text");
    }
    if (parsed) {
      const chats = Array.isArray(parsed.chats) ? parsed.chats : [];
      console.log(`list_chats: isError=false, chats=${chats.length}`);
      if (chats.length > 0) {
        console.log(`  fields: ${Object.keys(chats[0]).join(", ")}`);
      }
      if (chats.length > 3) fail(`limit 3 returned ${chats.length} chats`);
    }
  }
} catch (err) {
  fail(`${err instanceof Error ? err.message : String(err)}`);
} finally {
  await client.close().catch(() => {});
}

console.log(failed ? "SMOKE: FAILED" : "SMOKE: OK");
process.exit(failed ? 1 : 0);
