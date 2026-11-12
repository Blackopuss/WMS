// Links every skill of .agents/skills into .claude/skills, where Claude Code
// looks for them. That folder is not in git (a link is a different thing on
// Windows and on Linux), so each copy of the repository makes its own with
// `npm run skills:link`. Safe to repeat: what already exists is left alone.
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  symlinkSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(root, ".agents", "skills");
const target = path.join(root, ".claude", "skills");

if (!existsSync(source)) process.exit(0);
mkdirSync(target, { recursive: true });

const exists = (file) => {
  try {
    lstatSync(file);
    return true;
  } catch {
    return false;
  }
};

const linked = [];
for (const entry of readdirSync(source, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const link = path.join(target, entry.name);
  if (exists(link)) continue;
  try {
    // A junction needs no special permission on Windows; elsewhere the type
    // is ignored and a relative link keeps working if the folder moves.
    symlinkSync(
      process.platform === "win32"
        ? path.join(source, entry.name)
        : path.join("..", "..", ".agents", "skills", entry.name),
      link,
      "junction",
    );
    linked.push(entry.name);
  } catch (error) {
    console.error(
      `No se pudo enlazar la skill ${entry.name}: ${error.message}`,
    );
  }
}
if (linked.length > 0) console.log(`Skills enlazadas: ${linked.join(", ")}`);
