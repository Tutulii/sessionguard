import { readdir, readFile } from "node:fs/promises";
import { extname, join, relative } from "node:path";

const root = process.cwd();
const ignored = new Set(["node_modules", "dist", "dist-server", ".data", "test-results", ".git"]);
const extensions = new Set([".ts", ".tsx", ".js", ".mjs", ".json", ".toml", ".yml", ".yaml", ".md"]);
const patterns = [
  ["AWS access key", /AKIA[0-9A-Z]{16}/],
  ["private key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ["live-looking bearer secret", /\b(?:sk|xoxb|ghp)_[A-Za-z0-9_-]{24,}\b/],
];
const findings = [];

async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (ignored.has(entry.name) || entry.name.startsWith(".env")) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await walk(path);
    else if (extensions.has(extname(entry.name))) {
      const text = await readFile(path, "utf8");
      for (const [name, pattern] of patterns) if (pattern.test(text)) findings.push(`${relative(root, path)}: ${name}`);
    }
  }
}

await walk(root);
if (findings.length) {
  process.stderr.write(`Potential committed secrets:\n${findings.join("\n")}\n`);
  process.exit(1);
}
process.stdout.write("Secret-pattern scan passed.\n");
