const fs = require("fs");
const path = require("path");
const jsObfuscator = require("javascript-obfuscator");
const { execSync } = require("child_process");
const ResEdit = require("resedit");
const { info, error, success } = require("./logs");

const ob = process.argv.includes("--obfuscate");
let useEsbuild = false;

try {
  execSync("npx esbuild --version", { stdio: "ignore" });
  useEsbuild = true;
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

function packageMacOS(appRoot, distDir, appName) {
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

  success(`Successfully packaged macOS app at: ${appBundlePath}`);
}

function packageWindows(appRoot, distDir, appName) {
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

  copyDirRecursive(binFolder, outputFolder);

  const resourcesPath = path.join(outputFolder, "resources");
  fs.mkdirSync(resourcesPath, { recursive: true });

  handleJavaScriptPipeline(appRoot, resourcesPath);

  const oldBinaryPath = path.join(outputFolder, "positron-runtime.exe");
  const newBinaryPath = path.join(outputFolder, `${appName}.exe`);
  fs.renameSync(oldBinaryPath, newBinaryPath);


  info(`[Packager] Injecting application icon...`);
  try {
    const iconPath = path.join(appRoot, "icon.ico"); 

    const exeBuffer = fs.readFileSync(newBinaryPath);
    const iconBuffer = fs.readFileSync(iconPath);

    const exe = ResEdit.NtExecutable.from(exeBuffer);
    const res = ResEdit.NtExecutableResource.from(exe);

    const iconFile = ResEdit.Data.IconFile.from(iconBuffer);
    ResEdit.Resource.IconGroupEntry.replaceIconsForResource(
      res.entries,
      1, // Icon Group ID (1 is standard for primary app icons)
      1033, // Language ID (1033 = English - United States)
      iconFile.icons.map((item) => item.data) 
    );

    res.outputResource(exe);
    const newExeBuffer = exe.generate();

    fs.writeFileSync(newBinaryPath, Buffer.from(newExeBuffer));

    success(`[Packager] Icon injection successful.`);
  } catch (err) {
    error(`[Packager] Failed to set app icon: ${err.message}`, err.stack);
  }

  const macBinaryPath = path.join(outputFolder, "positron-runtime");
  if (fs.existsSync(macBinaryPath)) {
    fs.rmSync(macBinaryPath);
  }

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
}

module.exports = performPackager;