const fs = require("fs");
const path = require("path");

function performPackager() {
  const appRoot = process.cwd();
  const rootPackage = JSON.parse(fs.readFileSync(path.join(appRoot, "package.json"), "utf8"));
  
  const appName = rootPackage.name || "PositronApp";
  const distDir = path.join(appRoot, "dist");
  
  if (fs.existsSync(distDir)) fs.rmSync(distDir, { recursive: true, force: true });
  fs.mkdirSync(distDir, { recursive: true });

  if (process.platform === "darwin") {
    packageMacOS(appRoot, distDir, appName);
  } else if (process.platform === "win32") {
    packageWindows(appRoot, distDir, appName);
  }
}

function packageMacOS(appRoot, distDir, appName) {
  // macOS requires a strict structural hierarchy: App.app/Contents/MacOS/
  const appBundlePath = path.join(distDir, `${appName}.app`);
  const contentsPath = path.join(appBundlePath, "Contents");
  const macosPath = path.join(contentsPath, "MacOS");
  const resourcesPath = path.join(contentsPath, "Resources"); // Where your JS code goes

  fs.mkdirSync(macosPath, { recursive: true });
  fs.mkdirSync(resourcesPath, { recursive: true });

  console.log(`[Packager] Creating macOS App Bundle structure...`);

  // 1. Copy the compiled native runtime binary to the MacOS directory
  const compiledBinary = path.join(appRoot, "bin", "positron-runtime");
  if (!fs.existsSync(compiledBinary)) {
    console.error("Fatal: Native compiled binary missing from bin/. Run build first.");
    process.exit(1);
  }
  // macOS expects the main binary name to match the filename of the .app wrapper
  fs.copyFileSync(compiledBinary, path.join(macosPath, appName));
  fs.chmodSync(path.join(macosPath, appName), "755"); // Ensure it remains executable
  const packageJsonPath = path.join(appRoot, "package.json");
  const package = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));

  // 2. Generate the mandatory Info.plist meta-file
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

  // 3. Bundle JavaScript Application Source Code
  console.log(`[Packager] Copying application assets into app bundle...`);
  copyAppAssets(appRoot, resourcesPath);

  console.log(`\n🎉 Successfully packaged app at: ${appBundlePath}`);
}

function packageWindows(appRoot, distDir, appName) {
  const outputFolder = path.join(distDir, appName);
  fs.mkdirSync(outputFolder, { recursive: true });

  console.log(`[Packager] Creating Windows App structure...`);

  // 1. Copy compiled Windows executable
  const compiledExe = path.join(appRoot, "bin", "positron-runtime.exe");
  fs.copyFileSync(compiledExe, path.join(outputFolder, `${appName}.exe`));

  // 2. Copy code into a local resources directory alongside the exe
  const resourcesPath = path.join(outputFolder, "resources");
  fs.mkdirSync(resourcesPath, { recursive: true });
  
  copyAppAssets(appRoot, resourcesPath);

  console.log(`\n🎉 Successfully packaged Windows app directory at: ${outputFolder}`);
}

// Utility function to copy developer code while ignoring distribution/build folders
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
        fs.copyFileSync(srcPath, destPath);
      }
    }
  }

  copyRecursive(src, dest);
  
}

module.exports = performPackager;