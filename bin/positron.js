#! /usr/bin/env node

const { performNativeBuild } = require("../builder");
const performPackager = require("../packager");
const { spawn } = require("child_process");
const [, , command] = process.argv;
const { info, success:s, error, warn } = require("../logs");
const fs = require("fs");
const trash = require("../trash");
const path = require("path");

const coreWinDir = path.join(__dirname, "..", "core", "win");
const coreLinuxDir = path.join(__dirname, "..", "core", "linux");
const coreMacDir = path.join(__dirname, "..", "core", "mac");

switch (command) {
  case "build":
    info("Starting manual Positron build...");
    const success = performNativeBuild();
    process.exit(success ? 0 : 1);
    break;

  case "dev":
    info("Starting Positron in development mode...");
    const buildSuccess = performNativeBuild();
    if (!buildSuccess) {
      error("Development build failed. Please fix the errors and try again.");
      process.exit(1);
    }
    spawn("node", ["."], { stdio: "inherit" });
    break;

    case "run":
    spawn("node", ["."], { stdio: "inherit" });
    break;

  case "package":
        info("Packaging Positron application for production...");
        const buildPassed = performNativeBuild();
    if (!buildPassed) {
      error("Packaging aborted due to build failures.");
      process.exit(1);
    }

    performPackager();
    break;

  case "restore":
    info("Restoring .NET project files...");
    const args = process.argv.slice(3);
    spawn("dotnet", ["restore", ...args], { stdio: "inherit", cwd:coreWinDir });
    break;

  case "clean":
    if(process.argv.includes("--force")) {
      warn("Force flag detected. Performing permanent deletion of dist directory...");
      fs.rmSync(path.join(process.cwd(), 'dist'), { recursive: true, force: true });
      s("Clean completed.");
      break;
    }
    info("Performing clean of dist directory...");
    trash(path.join(process.cwd(), 'dist'));
    s("Clean completed. Please empty your system trash to permanently remove the files.");
    break;

  case "deepclean":
    if(process.argv.includes("--force")) {
      warn("Force flag detected. Performing permanent deletion of dist and bin directories...");
      fs.rmSync(path.join(process.cwd(), 'dist'), { recursive: true, force: true });
      fs.rmSync(path.join(process.cwd(), 'bin'), { recursive: true, force: true });
      s("Deep clean completed.");
      break;
    }
    info("Performing deep clean of dist and bin directories...");
    trash(path.join(process.cwd(), 'dist'));
    trash(path.join(process.cwd(), 'bin'));
    s("Deep clean completed. Please empty your system trash to permanently remove the files.");
    break;

  default:
    console.log("Usage: npx positron [build | dev | run | package | restore | clean | deepclean]");
    process.exit(0);
}