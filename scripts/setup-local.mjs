#!/usr/bin/env node
// Creates .venv with yt-dlp and faster-whisper for free local transcription. Re-run any time to update.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

const win = process.platform === "win32";
const venv = path.resolve(".venv");
const python = path.join(venv, win ? "Scripts/python.exe" : "bin/python");

function run(cmd, args) {
  console.log(`> ${cmd} ${args.join(" ")}`);
  execFileSync(cmd, args, { stdio: "inherit" });
}

if (!existsSync(python)) {
  const candidates = win ? ["py", "python"] : ["python3", "python"];
  const system = candidates.find((c) => {
    try {
      execFileSync(c, ["--version"], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  });
  if (!system) {
    console.error("Python 3.9+ is required: https://www.python.org/downloads/");
    process.exit(1);
  }
  run(system, ["-m", "venv", venv]);
}
run(python, ["-m", "pip", "install", "--upgrade", "pip"]);
run(python, ["-m", "pip", "install", "--upgrade", "-r", "requirements.txt"]);

console.log(`
Done. yt-dlp and faster-whisper are installed in .venv and will be used automatically.
The Whisper model (~0.5 GB for "small") downloads on first use into data/models.
Start the app with: npm run build && npm start`);
