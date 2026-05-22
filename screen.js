const { execSync } = require('child_process');

function getScreenSize() {
  const platform = process.platform;

  try {
    if (platform === 'win32') {
      const cmd = "powershell -command \"Get-CimInstance Win32_VideoController | Select-Object CurrentHorizontalResolution, CurrentVerticalResolution | Format-List\"";
      const output = execSync(cmd).toString();
      const width = output.match(/CurrentHorizontalResolution\s*:\s*(\d+)/)?.[1];
      const height = output.match(/CurrentVerticalResolution\s*:\s*(\d+)/)?.[1];
      return { width: parseInt(width), height: parseInt(height) };
    } 
    
    if (platform === 'darwin') {
      const cmd = "system_profiler SPDisplaysDataType | grep Resolution";
      const output = execSync(cmd).toString();
      const match = output.match(/(\d+) x (\d+)/);
      return { width: parseInt(match[1]), height: parseInt(match[2]) };
    } 

  } catch (error) {
    console.error("Failed to fetch screen size:", error.message);
  }
  
  return { width: 0, height: 0 };
}

module.exports = { getScreenSize };