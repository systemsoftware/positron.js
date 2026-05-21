const fs = require("fs");
const path = require("path");
const { info } = require("./logs");

class PositronRegistry {
  constructor(appRoot) {
    this.appRoot = appRoot; 
    this.nativeExtensions = [];
  }

  discover() {
    const rootPackagePath = path.join(this.appRoot, "package.json");
    if (!fs.existsSync(rootPackagePath)) return;

    const rootPackage = JSON.parse(fs.readFileSync(rootPackagePath, "utf8"));
    const dependencies = Object.keys(rootPackage.dependencies || {});

    for (const dep of dependencies) {
      const depPackagePath = path.join(this.appRoot, "node_modules", dep, "package.json");
      
      if (fs.existsSync(depPackagePath)) {
        const depPackage = JSON.parse(fs.readFileSync(depPackagePath, "utf8"));
        
        if (depPackage.positron) {
          const depDir = path.dirname(depPackagePath);
          this.nativeExtensions.push({
            name: depPackage.positron.command,
            sourceFile: path.join(depDir, depPackage.positron.platforms[process.platform])
          });
        }
      }
    }
    
    info(`Discovered ${this.nativeExtensions.length} native Positron extensions.`);
  }
}