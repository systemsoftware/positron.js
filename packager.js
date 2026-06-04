const fs = require("fs");
const path = require("path");
const { execSync, execFileSync } = require("child_process");
const { info, error, success } = require("./logs");
const https = require("https");
const esbuild = require("esbuild");
const findPackageJson = require("./findpackage");

const MAJOR_NODE_V = 24;

const ob = process.argv.includes("--obfuscate");

const arch = process.argv.includes("--x64") ? "x64" : process.argv.includes("--arm64") ? "arm64" : process.arch;

function performPackager() {
  const appRoot = process.cwd();
  const rootPackage = findPackageJson(appRoot)?.packageJson;
  
  const appName = process.env.POSITRON_APP_NAME || rootPackage.productName || rootPackage.name || "PositronApp";
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
  let bundledFiles = [];

    info(`[Packager] Bundling JavaScript code with esbuild...`);
    try {
      const result = esbuild.buildSync({
        entryPoints: [path.join(appRoot, "index.js")],
        bundle: true,
        platform: "node",
        target: `node${MAJOR_NODE_V}`,
        outfile: targetOutputFile,
        minify: true,
        sourcemap: false,
        metafile: true,
      });
      bundledFiles = Object.keys(result.metafile.inputs).map(f => path.resolve(appRoot, f));
    } catch (err) {
      error("Fatal: esbuild bundling failed.");
      process.exit(1);
    }

    copyAppAssets(appRoot, resourcesPath, bundledFiles);

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
  const binaryPath = path.join(macosPath, appName);
  fs.copyFileSync(compiledBinary, binaryPath);
  fs.chmodSync(binaryPath, "755"); 



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

  const bundledJs = path.join(resourcesPath, "index.js");
  const backendName = appName.replace(/([a-z0-9])([A-Z])/g, '$1-$2').replace(/[\s_]+/g, '-').toLowerCase() + '-backend';
  if (fs.existsSync(bundledJs)) {
    await compileWithPkg(bundledJs, "darwin", resourcesPath, backendName);
    const binPathEscaped = path.join(resourcesPath, backendName).replace(/"/g, '\\"');
   
          try {
        let swiftScript = "";
     if(fs.existsSync(path.join(__dirname, ['positronicon', 'png'].join('.')))) {
        const iconPathEscaped = path.join(__dirname, ['positronicon', 'png'].join('.')).replace(/"/g, '\\"');
        swiftScript = `import Cocoa; NSWorkspace.shared.setIcon(NSImage(contentsOfFile: "${iconPathEscaped}"), forFile: "${binPathEscaped}", options: []);`;
        }
         execFileSync("swift", ["-e", swiftScript], { stdio: "ignore" });
      } catch (err) {
        error("Failed to set custom icon on native binary:", err);
      }
    
  }

  fs.rmSync(path.join(resourcesPath, "icon.ico"), { force: true });

  if(!process.argv.includes('--keep-package-json') || !process.argv.includes('--kpj')) {
    fs.rmSync(path.join(resourcesPath, "package.json"), { force: true });
  }

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

  const bundledJs = path.join(resourcesPath, "index.js");
  const backendName = appName.replace(/([a-z0-9])([A-Z])/g, '$1-$2').replace(/[\s_]+/g, '-').toLowerCase() + '-backend';
  
  if (fs.existsSync(bundledJs)) {
        await compileWithPkg(bundledJs, "win32", resourcesPath, backendName);
  } else {
    error(`[Packager] Fatal: Bundled JavaScript entry point missing at ${bundledJs}`);
    process.exit(1);
  }

  fs.rmSync(path.join(resourcesPath, "icon.icns"), { force: true });
  fs.rmSync(path.join(resourcesPath, "icon.ico"), { force: true });

    if(!process.argv.includes('--keep-package-json') || !process.argv.includes('--kpj')) {
    fs.rmSync(path.join(resourcesPath, "package.json"), { force: true });
  }

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

function copyAppAssets(src, dest, ignoredFiles = []) {
  const ignoreList = ["node_modules", "dist", "bin", ".git"];
  
  function copyRecursive(currentSrc, currentDest) {
    const items = fs.readdirSync(currentSrc);
    for (const item of items) {
      if (ignoreList.includes(item)) continue;

      const srcPath = path.join(currentSrc, item);
      if (ignoredFiles.includes(srcPath)) continue;

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


const { exec } = require("@yao-pkg/pkg");

async function compileWithPkg(bundledJsPath, targetPlatform, outputFolder, appName) {

  if(process.argv.includes("--no-pkg")) {
    const finalPath = path.join(outputFolder, "index.js");
    fs.copyFileSync(bundledJsPath, finalPath);
    success(`[Packager] Skipped pkg compilation. Copied bundled JavaScript to: ${finalPath}`);
    return;
  }

  info(`[Packager] Packaging application into a standalone binary...`);

  let pkgTarget = "";
  let finalBinaryName = appName;

  info(`[Packager] Detected target platform: ${targetPlatform}, architecture: ${arch}`);

  if (targetPlatform === "win32") {
    pkgTarget = `node${MAJOR_NODE_V}-win-${arch}`;
    finalBinaryName = `${appName}.exe`;
  } else if (targetPlatform === "darwin") {
    pkgTarget = `node${MAJOR_NODE_V}-macos-${arch}`;
  }

  const outputPath = path.join(outputFolder, finalBinaryName);

  const pkgArgs = [
    bundledJsPath,
    "--target", pkgTarget,
    "--output", outputPath
  ];

  try {
    await exec(pkgArgs);

    if (fs.existsSync(bundledJsPath)) {
      fs.rmSync(bundledJsPath);
    }

    success(`[Packager] pkg compilation complete: ${outputPath}`);
  } catch (err) {
    error(`[Packager] pkg compilation failed: ${err.message}`);
    process.exit(1);
  }
}

module.exports = performPackager;