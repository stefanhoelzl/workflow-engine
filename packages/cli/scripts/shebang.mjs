import { readFileSync, writeFileSync } from "node:fs";

const path = "dist/cli.js";
const shebang = "#!/usr/bin/env node\n";
const contents = readFileSync(path, "utf-8");
if (!contents.startsWith("#!")) {
	writeFileSync(path, shebang + contents);
}
