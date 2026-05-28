const { execSync } = require('child_process');

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