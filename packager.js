const fs = require("fs");
const path = require("path");
const jsObfuscator = require("javascript-obfuscator");
const { execSync } = require("child_process");
const ResEdit = require("resedit");
const { info, error, success } = require("./logs");
const extract = require("extract-zip");
const https = require("https");

const ob = process.argv.includes("--obfuscate");
let useEsbuild = false;

const copyBinary = (destPath) => {

  if(process.argv.includes("--nn") || process.argv.includes("--no-node") || useEsbuild === false) {
    info(`[Packager] Skipping Node.js binary inclusion.`);
    return;
  }

  info(`[Packager] Copying Node.js binary from local environment...`);
  const nodeBinaryPath = process.execPath;
  console.log("Node binary path:", nodeBinaryPath);

  if (!fs.existsSync(nodeBinaryPath)) {
    throw new Error(`Node.js binary not found at path: ${nodeBinaryPath}`);
  }

  fs.copyFileSync(nodeBinaryPath, destPath);
  fs.chmodSync(destPath, "755");
  success(`[Packager] Successfully copied Node.js binary to: ${destPath}`);
}

const downloadNodeBinary = (platform, bPath) => {

    if(process.argv.includes("--nn") || process.argv.includes("--no-node") || useEsbuild === false) {
    info(`[Packager] Skipping Node.js binary inclusion.`);
    return;
  }


  info(`[Packager] No local Node.js binary available. Downloading from official sources...`);
  const version = process.versions.node;
  const baseUrl = `https://nodejs.org/dist/v${version}`;
  let filename;

  switch (platform) {
    case "win32":
      filename = `node-v${version}-win-x64.zip`;
      break;
    case "darwin":
      filename = `node-v${version}-darwin-x64.tar.gz`;
      break;
    default:
      throw new Error(`Unsupported platform: ${platform}`);
  }

  const url = `${baseUrl}/${filename}`;
  info(`Downloading Node.js binary from: ${url}`);
  
  return new Promise((resolve, reject) => {
    https.get(url, (response) => {
      if (response.statusCode !== 200) {
        reject(new Error(`Failed to download Node.js binary. Status code: ${response.statusCode}`));
        return;
      }

      const data = [];
      response.on("data", (chunk) => data.push(chunk));
      response.on("end", async () => {
        const buffer = Buffer.concat(data);
        fs.writeFileSync(bPath, buffer);
        success(`[Packager] Downloaded Node.js binary to: ${bPath}`);
        await extract(bPath, { dir: path.dirname(bPath) });
        fs.rmSync(bPath);
        resolve();
      });
    }).on("error", (err) => reject(err));
  });
}

try {
  execSync("npx esbuild --version", { stdio: "ignore" });
  useEsbuild = true;

  if(process.argv.includes("--no-esbuild") || process.argv.includes("--ne")) {
    useEsbuild = false;
    info("[Packager] User requested to skip esbuild. Falling back to multi-file copying pipeline. (node_modules will be required at runtime!)");
  }

  info("[Packager] esbuild detected. Using single-file bundling pipeline.");
} catch (e) {
  useEsbuild = false;
  info("[Packager] WARNING: esbuild not found. Falling back to multi-file copying pipeline. (node_modules will be required at runtime!)");
}

function performPackager() {
  const appRoot = process.cwd();
  const rootPackage = JSON.parse(fs.readFileSync(path.join(appRoot, "package.json"), "utf8"));
  
  const appName = rootPackage.name || "PositronApp";
  const distDir = path.join(appRoot, "dist");
  
  if (fs.existsSync(distDir)) fs.rmSync(distDir, { recursive: true, force: true });
  fs.mkdirSync(distDir, { recursive: true });

  if (process.argv.includes("--mac") || process.argv.includes("--m")) {
    packageMacOS(appRoot, distDir, appName);
  } else if (process.argv.includes("--windows") || process.argv.includes("--w")) {
    packageWindows(appRoot, distDir, appName);
  } else {
    process.platform === "win32" ? packageWindows(appRoot, distDir, appName) : packageMacOS(appRoot, distDir, appName);
  }
}

function handleJavaScriptPipeline(appRoot, resourcesPath) {
  const targetOutputFile = path.join(resourcesPath, "index.js");

  if (useEsbuild) {
    info(`[Packager] Bundling JavaScript code with esbuild...`);
    try {
      execSync(`npx esbuild index.js --bundle --platform=node --target=node18 --outfile="${targetOutputFile}"`, { stdio: 'inherit' });
    } catch (err) {
      error("Fatal: esbuild bundling failed.");
      process.exit(1);
    }

    if (ob) {
      info(`[Packager] Obfuscating bundled application code...`);
      if (fs.existsSync(targetOutputFile)) {
        const code = fs.readFileSync(targetOutputFile, "utf8");
        const obfuscated = jsObfuscator.obfuscate(code, {
          compact: true,
          controlFlowFlattening: true,
        });
        fs.writeFileSync(targetOutputFile, obfuscated.getObfuscatedCode());
      }
    }
    
    copyAppAssets(appRoot, resourcesPath);

  } else {
    info(`[Packager] Copying raw application assets...`);
    copyAppAssetsFallback(appRoot, resourcesPath);
  }
}

async function packageMacOS(appRoot, distDir, appName) {
  const appBundlePath = path.join(distDir, `${appName}.app`);
  const contentsPath = path.join(appBundlePath, "Contents");
  const macosPath = path.join(contentsPath, "MacOS");
  const resourcesPath = path.join(contentsPath, "Resources"); 

  fs.mkdirSync(macosPath, { recursive: true });
  fs.mkdirSync(resourcesPath, { recursive: true });

  info(`[Packager] Creating macOS App Bundle structure...`);

  const compiledBinary = path.join(appRoot, "bin", "positron-runtime");
  if (!fs.existsSync(compiledBinary)) {
    error("Fatal: Native compiled binary missing from bin/. Run build first.");
    process.exit(1);
  }
  fs.copyFileSync(compiledBinary, path.join(macosPath, appName));
  fs.chmodSync(path.join(macosPath, appName), "755"); 
  
  const packageJsonPath = path.join(appRoot, "package.json");
  const package = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));

  const plistContent = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleExecutable</key>
    <string>${appName}</string>
    <key>CFBundleIdentifier</key>
    <string>com.${package.author || "positron"}.${appName.toLowerCase()}</string>
    <key>CFBundleName</key>
    <string>${appName}</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>CFBundleShortVersionString</key>
    <string>${package.version || "1.0.0"}</string>
    <key>CFBundleIconFile</key>
    <string>icon</string>
    <key>NSHighResolutionCapable</key>
    <true/>
    <key>NSHumanReadableCopyright</key>
    <string>${package.author || "Positron"}</string>
    <key>LSApplicationCategoryType</key>
    <string>${package.macCategory || "public.app-category.developer-tools"}</string>
</dict>
</plist>`;
  fs.writeFileSync(path.join(contentsPath, "Info.plist"), plistContent);

  handleJavaScriptPipeline(appRoot, resourcesPath);

    const targetNodePath = path.join(resourcesPath, "node");

  if(process.platform === "darwin") {
    copyBinary(targetNodePath);
  } else {
    await downloadNodeBinary("darwin", path.join(resourcesPath, "node.tar.gz"));
  }

  const bundledJs = path.join(resourcesPath, "index.js");
  if (fs.existsSync(bundledJs) && fs.existsSync(targetNodePath)) {
    compileToSea(targetNodePath, bundledJs, "darwin");
    
    fs.renameSync(targetNodePath, path.join(resourcesPath, "positron-backend"));
  }

  fs.rmSync(path.join(resourcesPath, "icon.ico"), { force: true });


  success(`Successfully packaged macOS app at: ${appBundlePath}`);
}

async function packageWindows(appRoot, distDir, appName) {
  const outputFolder = path.join(distDir, appName);
  fs.mkdirSync(outputFolder, { recursive: true });

  info(`[Packager] Creating Windows App structure...`);

  const binFolder = path.join(appRoot, "bin");
  
  function copyDirRecursive(src, dest) {
    fs.readdirSync(src, { withFileTypes: true }).forEach(entry => {
      const srcPath = path.join(src, entry.name);
      const destPath = path.join(dest, entry.name);
      if (entry.isDirectory()) {
        fs.mkdirSync(destPath, { recursive: true });
        copyDirRecursive(srcPath, destPath);
      } else {
        fs.copyFileSync(srcPath, destPath);
      }
    });
  }

  // Ensure binary source folder exists
  if (!fs.existsSync(binFolder)) {
    error("Fatal: bin/ directory missing. Run build first.");
    process.exit(1);
  }

  copyDirRecursive(binFolder, outputFolder);

  const resourcesPath = path.join(outputFolder, "resources");
  fs.mkdirSync(resourcesPath, { recursive: true });

  handleJavaScriptPipeline(appRoot, resourcesPath);

  const oldBinaryPath = path.join(outputFolder, "positron-runtime.exe");
  const newBinaryPath = path.join(outputFolder, `${appName}.exe`);
  
  if (fs.existsSync(oldBinaryPath)) {
    fs.renameSync(oldBinaryPath, newBinaryPath);
  } else if (!fs.existsSync(newBinaryPath)) {
    error(`Fatal: Could not find base Windows executable template at ${oldBinaryPath}`);
    process.exit(1);
  }

  // --- SAFE ICON INJECTION ---
  const iconPath = path.join(appRoot, "icon.ico"); 
  if (fs.existsSync(iconPath) && fs.existsSync(newBinaryPath)) {
    info(`[Packager] Injecting application icon...`);
    try {
      const exeBuffer = fs.readFileSync(newBinaryPath);
      const iconBuffer = fs.readFileSync(iconPath);

      // Fix 1: Added ignoreCert to avoid signature parsing crashes
      const exe = ResEdit.NtExecutable.from(exeBuffer, { ignoreCert: true });
      const res = ResEdit.NtExecutableResource.from(exe);

      const iconFile = ResEdit.Data.IconFile.from(iconBuffer);
      ResEdit.Resource.IconGroupEntry.replaceIconsForResource(
        res.entries,
        1,    // Icon Group ID
        1033, // Language ID (English - US)
        iconFile.icons.map((item) => item.data) 
      );

      res.outputResource(exe);
      const newExeBuffer = exe.generate();
      fs.writeFileSync(newBinaryPath, Buffer.from(newExeBuffer));
      success(`[Packager] Icon injection successful.`);
    } catch (err) {
      error(`[Packager] Failed to set app icon: ${err.message}`, err.stack);
    }
  } else {
    warn(`[Packager] Skipping icon injection: icon.ico or target executable was not found.`);
  }

  // --- RESOLVE & EXTRACT NODE BINARY ---
  if (process.platform === "win32") {
    copyBinary(path.join(resourcesPath, "node"));
  } else {
    await downloadNodeBinary("win32", path.join(resourcesPath, "node.tar.gz"));
  }

  // Helper to recursively find node.exe inside the extracted workspace
  function findNodeExe(dir) {
    if (!fs.existsSync(dir)) return null;
    const files = fs.readdirSync(dir);
    for (const file of files) {
      const fullPath = path.join(dir, file);
      if (fs.statSync(fullPath).isDirectory()) {
        const found = findNodeExe(fullPath);
        if (found) return found;
      } else if (file.toLowerCase() === 'node.exe') {
        return fullPath;
      }
    }
    return null;
  }

  // Find the exact target node.exe path dynamically
  let targetNodePath = path.join(resourcesPath, "node"); 
  if (process.platform !== "win32") {
    targetNodePath = findNodeExe(resourcesPath);
  }

  const bundledJs = path.join(resourcesPath, "index.js");
  
  if (targetNodePath && fs.existsSync(targetNodePath) && fs.existsSync(bundledJs)) {
    // Pass 'win32' as the target platform explicitly
    compileToSea(targetNodePath, bundledJs, "win32");
    
    // Move the finalized binary into place
    const finalBackendPath = path.join(resourcesPath, "positron-backend.exe");
    fs.renameSync(targetNodePath, finalBackendPath);
  } else {
    error(`[Packager] Fatal: Missing bundled JS or node.exe binary layout for SEA compilation.`);
    process.exit(1);
  }

  // Cleanup cross-platform clutter
  fs.rmSync(path.join(resourcesPath, "icon.icns"), { force: true });
  fs.rmSync(path.join(resourcesPath, "icon.ico"), { force: true });

  const macBinaryPath = path.join(outputFolder, "positron-runtime");
  if (fs.existsSync(macBinaryPath)) {
    fs.rmSync(macBinaryPath);
  }

  // Clean out empty extraction shell folders if they exist
  fs.readdirSync(resourcesPath).forEach(file => {
    const fullPath = path.join(resourcesPath, file);
    if (fs.statSync(fullPath).isDirectory() && file.startsWith("node-v") && file !== "node") {
      fs.rmSync(fullPath, { recursive: true, force: true });
    }
  });

  success(`Successfully packaged Windows app directory at: ${outputFolder}`);
}

function copyAppAssets(src, dest) {
  const ignoreList = ["node_modules", "dist", "bin", ".git"];
  
  function copyRecursive(currentSrc, currentDest) {
    const items = fs.readdirSync(currentSrc);
    for (const item of items) {
      if (ignoreList.includes(item)) continue;

      const srcPath = path.join(currentSrc, item);
      const destPath = path.join(currentDest, item);
      const stat = fs.statSync(srcPath);

      if (stat.isFile() && (item === "package-lock.json" || item.endsWith(".log"))) {
        continue;
      }

      if (stat.isDirectory()) {
        fs.mkdirSync(destPath, { recursive: true });
        copyRecursive(srcPath, destPath);
      } else {
        if (item.endsWith(".js")) continue;
        fs.copyFileSync(srcPath, destPath);
      }
    }
  }
  copyRecursive(src, dest);
}

function copyAppAssetsFallback(src, dest) {

  
  const ignoreList = ["node_modules", "dist", "bin", ".git"];
  
  function copyRecursive(currentSrc, currentDest) {
    const items = fs.readdirSync(currentSrc);
    for (const item of items) {
      if (ignoreList.includes(item)) continue;

      const srcPath = path.join(currentSrc, item);
      const destPath = path.join(currentDest, item);
      const stat = fs.statSync(srcPath);

      if (stat.isFile() && (item === "package-lock.json" || item.endsWith(".log"))) {
        continue;
      }

      if (stat.isDirectory()) {
        fs.mkdirSync(destPath, { recursive: true });
        copyRecursive(srcPath, destPath);
      } else {
        fs.copyFileSync(srcPath, destPath);
        if (ob) {
          if (destPath.endsWith(".js") && !destPath.includes("node_modules")) {
            const code = fs.readFileSync(destPath, "utf8");
            const obfuscated = jsObfuscator.obfuscate(code, {
              compact: true,
              controlFlowFlattening: true,
            });
            fs.writeFileSync(destPath, obfuscated.getObfuscatedCode());
          }
        }
      }
    }
  }
  copyRecursive(src, dest);

  const nodeModulesSrc = path.join(src, "node_modules");
  const nodeModulesDest = path.join(dest, "node_modules");
  if (fs.existsSync(nodeModulesSrc)) {
    info(`[Packager] Copying node_modules directory...`);
    fs.cpSync(nodeModulesSrc, nodeModulesDest, { recursive: true });
  }

  success(`[Packager] Application assets copied successfully.`);



}

function compileToSea(nodeBinaryPath, bundledJsPath, targetPlatform) {
  info(`[Packager] Transforming Node binary into a Single Executable Application (SEA)...`);

  const workingDir = path.dirname(bundledJsPath);
  const seaConfigPath = path.join(workingDir, "sea-config.json");
  const blobOutputPath = path.join(workingDir, "sea-prep.blob");

  const configContent = {
    main: bundledJsPath,
    output: blobOutputPath,
    disableSentinel: false // Keeps security integrity signatures intact
  };
  fs.writeFileSync(seaConfigPath, JSON.stringify(configContent, null, 2));

  try {
    info(`[Packager] Generating compilation blob using: ${process.version}...`);
    execSync(`node --experimental-sea-config "${seaConfigPath}"`, { cwd: workingDir, stdio: "ignore" });

    info(`[Packager] Injecting asset blob into binary structure...`);
    
    if (targetPlatform === "darwin") {
       try {
        execSync(`codesign --remove-signature "${nodeBinaryPath}"`, { stdio: "ignore" });
      } catch (e) {
        // Safe to ignore if the local binary was already unsigned
      }

      const nodeMajorVersion = parseInt(process.versions.node.split(".")[0], 10);
      const sentinelFuse = nodeMajorVersion >= 22 
        ? "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2" 
        : "NODE_SEA_FUSE_f490decade5332074d15715322471565";

      const postjectCommand = [
        `npx postject "${nodeBinaryPath}"`,
        `NODE_SEA_BLOB "${blobOutputPath}"`,
        `--sentinel-fuse ${sentinelFuse}`,
        `--macho-segment-name NODE_SEA`
      ].join(" ");

      execSync(postjectCommand, { stdio: "inherit" });

      try {
        execSync(`codesign --sign - "${nodeBinaryPath}"`, { stdio: "ignore" });
      } catch (e) {
        warn("[Packager] Ad-hoc code signing skipped. You may need to sign this bundle manually.");
      }

    } else if (targetPlatform === "win32") {
  const nodeMajorVersion = parseInt(process.versions.node.split(".")[0], 10);
  const sentinelFuse = nodeMajorVersion >= 22
    ? "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2"
    : "NODE_SEA_FUSE_f490decade5332074d15715322471565";

  const postjectCommand = [
    `npx postject "${nodeBinaryPath}"`,
    `NODE_SEA_BLOB "${blobOutputPath}"`,
    `--sentinel-fuse ${sentinelFuse}`
  ].join(" ");

  execSync(postjectCommand, { stdio: "inherit" });
}

    fs.rmSync(seaConfigPath, { force: true });
    fs.rmSync(blobOutputPath, { force: true });
    fs.rmSync(bundledJsPath, { force: true });

    success(`[Packager] SEA Compilation Complete.`);
  } catch (err) {
    error(`[Packager] Failed to generate Single Executable Application (SEA): ${err.message}`);
    process.exit(1);
  }
}

module.exports = performPackager;