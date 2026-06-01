#! /usr/bin/env node

const { performNativeBuild } = require("../builder");
const performPackager = require("../packager");
const { spawn } = require("child_process");
const [, , command] = process.argv;
const { info, success, error } = require("../logs");

switch (command) {
  case "build":
    info("Starting manual Positron build...");
    const success = performNativeBuild();
    process.exit(success ? 0 : 1);
    break;

  case "dev":
    info("Starting Positron in development mode...");
    performNativeBuild();
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

  default:
    console.log("Usage: npx positron [build | dev | run | package]");
    process.exit(0);
}