const { spawnSync } = require('child_process');

/**
 * Gets the screen size of the primary display. The implementation varies based on the operating system:
 * - On Windows, it uses PowerShell to query the current horizontal and vertical resolution of the video controller.
 * - On macOS, it uses the system_profiler command to extract the resolution information from the display data.
 * If the platform is not supported or if there is an error during execution, it returns a default size of { width: 0, height: 0 }.
 */
function getScreenSize() {
  const platform = process.platform;

  try {
    if (platform === 'win32') {
      const result = spawnSync("powershell", ["-command", "Get-CimInstance Win32_VideoController | Select-Object CurrentHorizontalResolution, CurrentVerticalResolution | Format-List"]);
      if (result.error || result.status !== 0) throw new Error("Failed to execute powershell");
      const output = result.stdout.toString();
      const width = output.match(/CurrentHorizontalResolution\s*:\s*(\d+)/)?.[1];
      const height = output.match(/CurrentVerticalResolution\s*:\s*(\d+)/)?.[1];
      return { width: parseInt(width), height: parseInt(height) };
    } 
    
    if (platform === 'darwin') {
      const result = spawnSync("system_profiler", ["SPDisplaysDataType"]);
      if (result.error || result.status !== 0) throw new Error("Failed to execute system_profiler");
      const output = result.stdout.toString().split('\\n').filter(line => line.includes('Resolution')).join('\\n');
      const match = output.match(/(\d+) x (\d+)/);
      return { width: parseInt(match[1]), height: parseInt(match[2]) };
    } 

  } catch (error) {
    console.error("Failed to fetch screen size:", error.message);
  }
  
  return { width: 0, height: 0 };
}

module.exports = { getScreenSize };