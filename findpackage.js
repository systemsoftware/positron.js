const fs = require('fs');
const path = require('path');

function findNearestPackageJson(startDir = process.cwd()) {
  let currentDir = path.resolve(startDir);
  const root = path.parse(currentDir).root;

  while (true) {
    const pkgPath = path.join(currentDir, 'package.json');

    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));

        return {
          path: pkgPath,
          dir: currentDir,
          packageJson: pkg,
        };
      } catch (err) {
        throw new Error(`Invalid package.json at ${pkgPath}`);
      }
    }

    if (currentDir === root) {
      return null;
    }

    currentDir = path.dirname(currentDir);
  }
}


module.exports = findNearestPackageJson;