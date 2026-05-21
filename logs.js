module.exports.success = (...msgs) => {
    console.log(`\x1b[32m[SUCCESS] ${msgs.join(' ').trim()}\x1b[0m`.trim());
}

module.exports.error = (...msgs) => {
    console.error(`\x1b[31m[ERROR] ${msgs.join(' ').trim()}\x1b[0m`.trim());
}

module.exports.info = (...msgs) => {
    console.info(`\x1b[34m[INFO] ${msgs.join(' ').trim()}\x1b[0m`.trim());
}

module.exports.warn = (...msgs) => {
  console.warn(`\x1b[33m[WARN] ${msgs.join(' ').trim()}\x1b[0m`.trim());
}

module.exports.special = (...msgs) => {
    console.log(`\x1b[35m${msgs.join(' ').trim()}\x1b[0m`.trim());
}