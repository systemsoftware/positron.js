const fs = require("fs");
const path = require("path");
const cp = require("child_process");
const { success, error, info, warn } = require("./logs");
const semver = require("semver");

const arch = process.argv.includes("--x64") ? "x64" : process.argv.includes("--arm64") ? "arm64" : process.arch;

function performNativeBuild() {


  let buildingForWindows = process.argv.includes("--windows") || process.argv.includes("--w");
  let buildingForMac = process.argv.includes("--mac") || process.argv.includes("--m");
  let buildingForLinux = process.argv.includes("--linux") || process.argv.includes("--l");


  const appRoot = process.cwd(); 
  const nativeExtensionsMac = [];
  const nativeExtensionsWindows = [];
  const nativeExtensionsLinux = [];
  
  const rootPackagePath = path.join(appRoot, "package.json");
  if (!fs.existsSync(rootPackagePath)) return false;

  const rootPackage = JSON.parse(fs.readFileSync(rootPackagePath, "utf8"));
  const dependencies = Object.keys(rootPackage.dependencies || {});

  for (const dep of dependencies) {
    const depPackagePath = path.join(appRoot, "node_modules", dep, "package.json");
    if (fs.existsSync(depPackagePath)) {
      const depPackage = JSON.parse(fs.readFileSync(depPackagePath, "utf8"));
      if (depPackage.positron) {
        const depDir = path.dirname(depPackagePath);

        if(depPackage.positron.requiredVersion) {
          const requiredVersion = depPackage.positron.requiredVersion.replace(/^[^\d]*/, ''); 
          const rootVersion = process.argv.find(arg => arg.startsWith("--pv="))?.split("=")[1] || rootPackage.dependencies["positron.js"] || rootPackage.devDependencies["positron.js"] || rootPackage.peerDependencies["positron.js"] || "0.0.0";
          if(rootVersion.startsWith("file:")) {
            warn(`[Builder] Dependency "${dep}" specifies a required positron.js version of ${requiredVersion}, but the project is using a local file reference. Skipping version compatibility check for this dependency.`);
          } else {
          if(!semver.gte(rootVersion, requiredVersion)) {
            warn(`[Builder] Dependency "${dep}" requires positron.js version ${requiredVersion}, but the project has version ${rootVersion}. This may lead to compatibility issues.`);
          }
        }
        } 

          let missing = [];
          if(!depPackage.positron.className) missing.push("className");
          if(!depPackage.positron.command) missing.push("command");
          if(!depPackage.positron.platforms) missing.push("platforms");
          else {
            if(!depPackage.positron.platforms.darwin) missing.push("platforms.darwin");
            if(!depPackage.positron.platforms.win32) missing.push("platforms.win32");
            if(!depPackage.positron.platforms.linux) missing.push("platforms.linux");
          }
          
          if(missing.includes("className") || missing.includes("command") || missing.includes("platforms")) {
            warn(`[Builder] Dependency "${dep}" has an invalid positron field. Missing: ${missing.join(", ")}. Skipping native extension build for this dependency.`);
            continue;
          }
        
        if(!missing.includes("platforms.darwin")) {
        nativeExtensionsMac.push({
          className: depPackage.positron.className, 
          command: depPackage.positron.command,
          sourceFile: path.join(depDir, depPackage.positron.platforms.darwin)
        });
      } else if(buildingForMac) {
        warn(`[Builder] Dependency "${dep}" is missing a macOS platform source file. Skipping macOS native extension build for this dependency.`);
      }
      if(!missing.includes("platforms.win32")) {
        nativeExtensionsWindows.push({
          className: depPackage.positron.className, 
          command: depPackage.positron.command,
          sourceFile: path.join(depDir, depPackage.positron.platforms.win32)
        });
      } else if(buildingForWindows) {
        warn(`[Builder] Dependency "${dep}" is missing a Windows platform source file. Skipping Windows native extension build for this dependency.`);
      }
      if(!missing.includes("platforms.linux")) {
        nativeExtensionsLinux.push({
          className: depPackage.positron.className, 
          command: depPackage.positron.command,
          sourceFile: path.join(depDir, depPackage.positron.platforms.linux)
        });
      } else if(buildingForLinux) {
        warn(`[Builder] Dependency "${dep}" is missing a Linux platform source file. Skipping Linux native extension build for this dependency.`);
      }
      }
    }
  }

  if(buildingForWindows == false && buildingForMac == false && buildingForLinux == false) {
    if (process.platform === "win32") {
      buildingForWindows = true;
    } else if (process.platform === "darwin") {
      buildingForMac = true;
    } else if (process.platform === "linux") {
      buildingForLinux = true;
    } else {
      error("[Builder] Unsupported platform for native build.");
      return false;
    }
  }

  if (buildingForMac) {

        const coreMacDir = path.join(__dirname, "core", "mac");

        nativeExtensionsMac.push({
          command:"createTray",
          className:"TrayExtension",
          sourceFile:path.join(coreMacDir, "tray.swift")
        }); 

        // -1 to account for the built-in tray extension
    info(`[Builder] Stitching ${nativeExtensionsMac.length-1} native extensions...`);
  
        let registryContent = `// Auto-generated by Positron. Do not edit.\n`;
    registryContent += `func getExtensionRegistry() -> [String: (Int, [String]) -> Void] {\n`;
    
    if (nativeExtensionsMac.length === 0) {
      registryContent += `    return [:]\n`;
    } else {
      registryContent += `    return [\n`;
      
      nativeExtensionsMac.forEach((ext, index) => {

         const comma = index === nativeExtensionsMac.length - 1 ? "" : ",";
         registryContent += `        "${ext.command}": ${ext.className}.handle${comma}\n`;
      });
      
      registryContent += `    ]\n`;
    }
    
    registryContent += `}\n`;
    
    fs.writeFileSync(path.join(coreMacDir, "Registry.swift"), registryContent);

    info("[Builder] Compiling native binary...");
    const outBinaryDir = path.join(appRoot, "bin");
    if (!fs.existsSync(outBinaryDir)) fs.mkdirSync(outBinaryDir, { recursive: true });

    const binaryName = "positron-runtime";
    const extensionSources = nativeExtensionsMac.map(e => e.sourceFile);
    
    let addedFrameworksSet = new Set();

    nativeExtensionsMac.forEach(ext => {
      if (ext.macFrameworks && Array.isArray(ext.macFrameworks)) {
        ext.macFrameworks.forEach(fw => {
          addedFrameworksSet.add(fw);
        });
      }
    });
    
    let addedFrameworksArgs = [];
    addedFrameworksSet.forEach(fw => {
      addedFrameworksArgs.push("-framework", fw);
    });

    try {
      cp.execFileSync("swiftc", [
        path.join(coreMacDir, "main.swift"),
        path.join(coreMacDir, "Registry.swift"),
        ...extensionSources,
        "-o", path.join(outBinaryDir, binaryName),
        "-framework", "Cocoa",
        "-framework", "WebKit",
        ...addedFrameworksArgs
      ], { stdio: "inherit" });
      success("[Builder] Native compilation successful.");

          if(process.platform == "darwin") {
      cp.execFile("chmod", ["+x", path.join(outBinaryDir, binaryName)], (err) => {
        if (err) {
          error("Failed to set executable permissions on native binary:", err);
        }
      });

      try {
        let swiftScript = "";
        if(fs.existsSync(path.join(appRoot, "icon.icns"))) {
           const iconPathEscaped = path.join(appRoot, "icon.icns").replace(/"/g, '\\"');
        const binPathEscaped = path.join(outBinaryDir, binaryName).replace(/"/g, '\\"');
        swiftScript = `import Cocoa; NSWorkspace.shared.setIcon(NSImage(contentsOfFile: "${iconPathEscaped}"), forFile: "${binPathEscaped}", options: []); `;
        cp.execFileSync("swift", ["-e", swiftScript], { stdio: "ignore" });
          return true;
        } else if(fs.existsSync(path.join(__dirname, ['positronicon', 'png'].join('.')))) {
        const iconPathEscaped = path.join(__dirname, ['positronicon', 'png'].join('.')).replace(/"/g, '\\"');
        const binPathEscaped = path.join(outBinaryDir, binaryName).replace(/"/g, '\\"');
        swiftScript = `import Cocoa; NSWorkspace.shared.setIcon(NSImage(contentsOfFile: "${iconPathEscaped}"), forFile: "${binPathEscaped}", options: []);`;
        }
         cp.execFileSync("swift", ["-e", swiftScript], { stdio: "ignore" });
      } catch (err) {
        error("Failed to set custom icon on native binary:", err);
      }
    }

      return true;
    } catch (err) {
      error("[Builder] Compilation failed:", err.message);
      return false;
    }
    } 
    
    
     if (buildingForWindows) {
    info(`[Builder] Stitching ${nativeExtensionsWindows.length} native Windows extensions...`);

    const coreWinDir = path.join(__dirname, "core", "win");
    const extensionsDir = path.join(coreWinDir, "extensions");


    // 1. Clean and prepare a staging folder for all native extensions
    if (fs.existsSync(extensionsDir)) fs.rmSync(extensionsDir, { recursive: true, force: true });
    fs.mkdirSync(extensionsDir, { recursive: true });

    let registryContent = `// Auto-generated by Positron. Do not edit.\n`;
    registryContent += `using System;\nusing System.Collections.Generic;\n\n`;
    registryContent += `namespace PositronWindows {\n`;
    registryContent += `    public static class ExtensionRegistry {\n`;
    registryContent += `        public static Dictionary<string, Action<int, List<string>>> GetExtensions() {\n`;
    registryContent += `            return new Dictionary<string, Action<int, List<string>>> {\n`;

    nativeExtensionsWindows.forEach((ext, index) => {
        const comma = index === nativeExtensionsWindows.length - 1 ? "" : ",";
        registryContent += `                { "${ext.command}", ${ext.className}.Handle }${comma}\n`;

        const destFile = path.join(extensionsDir, `ext_${index}.cs`);
        fs.copyFileSync(ext.sourceFile, destFile);
    });

    registryContent += `            };\n`;
    registryContent += `        }\n`;
    registryContent += `    }\n}\n`;

    fs.writeFileSync(path.join(extensionsDir, "Registry.cs"), registryContent);

    info("[Builder] Compiling Windows native binary via .NET CLI...");
    const outBinaryDir = path.join(appRoot, "bin");
    if (!fs.existsSync(outBinaryDir)) fs.mkdirSync(outBinaryDir, { recursive: true });

    try {

      const iconPath = path.join(appRoot, "icon.ico");
      const isSelfContained = !process.argv.includes("--no-self-contained");
      const dotnetArgs = [
        "publish",
        path.join(coreWinDir, "PositronRuntime.csproj"),
        "-c", "Release",
        "-r", `win-${arch}`,
        "--self-contained", isSelfContained ? "true" : "false",
        "-o", outBinaryDir,
        "/p:PublishSingleFile=true"
      ];
      if (isSelfContained) {
        dotnetArgs.push("/p:IncludeNativeLibrariesForSelfContained=true");
        dotnetArgs.push("/p:EnableCompressionInSingleFile=true");
      } else {
        warn("[Builder] Building a framework-dependent executable. Ensure the target system has the appropriate .NET runtime installed.");
      }
      if (fs.existsSync(iconPath)) {
        dotnetArgs.push(`/p:ApplicationIcon=${iconPath}`);
      }

const args = process.argv;
const argIndex = args.findIndex(arg => arg === "--dotnet");

if (argIndex !== -1) {
  let netVersion = "";

  if (args[argIndex].includes("=")) {
    netVersion = args[argIndex].split("=")[1];
  } else if (argIndex + 1 < args.length) {
    netVersion = args[argIndex + 1];
  }

  if (netVersion) {
    netVersion = netVersion.replace(/^net/i, "");
    
    info(`[Builder] Restoring packages for ${netVersion}...`);
    cp.execFileSync('dotnet', ['restore', path.join(coreWinDir, "PositronRuntime.csproj"), `/p:TargetFramework=net${netVersion}-windows`, `/p:RuntimeIdentifier=win-${arch}`], { stdio: 'inherit' });
    
    info(`[Builder] Targeting .NET version ${netVersion}`);
    dotnetArgs.push(`/p:TargetFramework=net${netVersion}-windows`);
  }
}

      const appName = rootPackage.productName || rootPackage.name || "PositronApp";
      const version = rootPackage.version || "1.0.0";
      const author = rootPackage.author || "Positron";
      const bundleId = rootPackage.bundleIdentifier || `com.${author.toLowerCase().replace(/[^a-z0-9]/g, '')}.${appName.toLowerCase().replace(/[^a-z0-9]/g, '')}`;
      const winCategory = rootPackage.winCategory || rootPackage.macCategory || "An application built with Positron.js";

      dotnetArgs.push(`/p:Version=${version}`);
      dotnetArgs.push(`/p:Authors=${author}`);
      dotnetArgs.push(`/p:Company=${author}`);
      dotnetArgs.push(`/p:Product=${bundleId}`);
      dotnetArgs.push(`/p:Description=${winCategory}`);

      if(argIndex !== -1) {
        dotnetArgs.push('--no-restore')
      }

      cp.execFileSync("dotnet", dotnetArgs, { stdio: "inherit" });
      success("[Builder] Windows native compilation successful.");
      return true;
    } catch (err) {
      error("[Builder] Windows compilation failed:", err.message);
      return false;
    }
  }
  
  if (buildingForLinux) {
    info(`[Builder] Stitching ${nativeExtensionsLinux.length} native Linux extensions...`);
    
    const coreLinuxDir = path.join(__dirname, "core", "linux");
    
    let registryContent = `// Auto-generated by Positron. Do not edit.\n`;
    registryContent += `#include <string>\n#include <unordered_map>\n#include <vector>\n\n`;
    registryContent += `using namespace std;\n\n`;
    
    nativeExtensionsLinux.forEach((ext, index) => {
        registryContent += `void handle_${ext.className}(int windowId, vector<string> args);\n`;
    });
    
    registryContent += `\nunordered_map<string, void(*)(int, vector<string>)> getExtensionRegistry() {\n`;
    registryContent += `    return {\n`;
    
    nativeExtensionsLinux.forEach((ext, index) => {
        const comma = index === nativeExtensionsLinux.length - 1 ? "" : ",";
        registryContent += `        {"${ext.command}", handle_${ext.className}}${comma}\n`;
    });
    
    registryContent += `    };\n}\n`;
    
    fs.writeFileSync(path.join(coreLinuxDir, "Registry.cpp"), registryContent);

    if (process.platform !== "linux") {
      info("[Builder] Cross-compiling for Linux using Docker...");
      try {
        const dockerVer = cp.spawnSync("docker", ["--version"], { stdio: "ignore" });
        if (dockerVer.error || dockerVer.status !== 0) throw new Error("Docker is not available");
      } catch (e) {
        error("[Builder] Fatal: Docker is required to cross-compile for Linux on macOS/Windows.");
        process.exit(1);
      }

      const dockerArch = arch === "arm64" ? "linux/arm64" : "linux/amd64";
      const dockerTag = `positron-linux-builder-${arch}`;
      const dockerfileContent = [
        "FROM ubuntu:latest",
        "ENV DEBIAN_FRONTEND=noninteractive",
        "RUN apt-get update && apt-get install -y "+
          "g++ pkg-config "+
          "libgtk-3-dev libwebkit2gtk-4.1-dev libjson-glib-dev "+
          "libsoup2.4-dev libnotify-dev",
        "WORKDIR /app"
      ].join("\n");
      
      fs.writeFileSync(path.join(coreLinuxDir, "Dockerfile.linux"), dockerfileContent);
      info(`[Builder] Building Docker image for ${dockerArch}...`);
      
      try {
        const buildRes = cp.spawnSync("docker", ["build", "--platform", dockerArch, "-t", dockerTag, "-f", path.join(coreLinuxDir, "Dockerfile.linux"), coreLinuxDir], { stdio: "inherit" });
        if (buildRes.error) throw buildRes.error;
        if (buildRes.status !== 0) throw new Error("Docker build failed");

        const outBinaryDir = path.join(appRoot, "bin");

        if(!fs.existsSync(outBinaryDir)) fs.mkdirSync(outBinaryDir, { recursive: true });

        let dockerArgs = ["run", "--rm", "--platform", dockerArch, "-v", `${appRoot}:/app`, "-v", `${__dirname}:/framework`];

        const mappedExtensions = nativeExtensionsLinux.map((e, i) => {
          let s;
          try { s = fs.realpathSync(e.sourceFile); } catch(err) { s = e.sourceFile; }
          const realAppRoot = fs.realpathSync(appRoot);
          const realDirname = fs.realpathSync(__dirname);

          if (s.startsWith(realAppRoot)) {
            return "/app/" + path.relative(realAppRoot, s).replace(/\\/g, '/');
          } else if (s.startsWith(realDirname)) {
            return "/framework/" + path.relative(realDirname, s).replace(/\\/g, '/');
          } else {
            const extDir = path.dirname(s);
            dockerArgs.push("-v", `${extDir}:/ext_${i}`);
            return `/ext_${i}/${path.basename(s)}`;
          }
        });

        const compilerIndex = process.argv.findIndex(arg => arg === "--compiler");
        const compiler = (compilerIndex !== -1 && process.argv.length > compilerIndex + 1) ? process.argv[compilerIndex + 1] : "g++";

        const gccArgs = [
          compiler, "-O3",
          "/framework/core/linux/main.cpp",
          "/framework/core/linux/Registry.cpp",
          ...mappedExtensions,
          "-o", "/app/bin/positron-runtime",
          "$(pkg-config --cflags --libs gtk+-3.0 webkit2gtk-4.1 json-glib-1.0 libnotify)"
        ].join(" ");
        
        info("[Builder] Compiling inside Docker container...");
        dockerArgs.push(dockerTag, "bash", "-c", gccArgs);
        const runRes = cp.spawnSync("docker", dockerArgs, { stdio: "inherit" });
        if (runRes.error) throw runRes.error;
        if (runRes.status !== 0) throw new Error("Docker run failed");
        
        success("[Builder] Linux native cross-compilation successful.");
        return true;
      } catch (err) {
        error("[Builder] Linux cross-compilation via Docker failed:", err.message);
        return false;
      }
    } else {
      info("[Builder] Compiling Linux native binary natively via g++...");
      try {
        const pkgRes = cp.spawnSync("pkg-config", ["--cflags", "--libs", "gtk+-3.0", "webkit2gtk-4.1", "json-glib-1.0", "libnotify"], { encoding: 'utf8' });
        if (pkgRes.error) throw pkgRes.error;
        if (pkgRes.status !== 0) throw new Error("pkg-config failed");
        const pkgConfigOutput = pkgRes.stdout.trim().split(/\\s+/);
        
        const extensionSources = nativeExtensionsLinux.map(e => e.sourceFile);
        const gccArgs = [
          "-O3",
          path.join(coreLinuxDir, "main.cpp"),
          path.join(coreLinuxDir, "Registry.cpp"),
          ...extensionSources,
          "-o", path.join(outBinaryDir, "positron-runtime"),
          ...pkgConfigOutput
        ];

        cp.execFileSync("g++", gccArgs, { stdio: "inherit" });
        success("[Builder] Linux native compilation successful.");
        return true;
      } catch (err) {
        error("[Builder] Linux compilation failed:", err.message);
        warn("Ensure you have installed: libgtk-3-dev libwebkit2gtk-4.1-dev libjson-glib-dev libsoup2.4-dev");
        return false;
      }
    }
  }

  return false; // Unsupported platform
 
}

module.exports = { performNativeBuild };