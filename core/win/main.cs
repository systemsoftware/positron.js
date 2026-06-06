using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Threading;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.Wpf;
using System.Text.Json.Serialization;
using System.Net;
using System.Net.Sockets;
using Microsoft.VisualBasic;
using System.Runtime.InteropServices;
using Microsoft.Win32;
using System.Linq;

class PowerSaveBlocker
{
    // Import the Win32 API
    [DllImport("kernel32.dll")]
    private static extern uint SetThreadExecutionState(uint esFlags);

    // Flags
    private const uint ES_CONTINUOUS       = 0x80000000;
    private const uint ES_SYSTEM_REQUIRED  = 0x00000001;
    private const uint ES_DISPLAY_REQUIRED = 0x00000002;

    private static uint currentState = 0;
    
    public static void BlockPowerSave(bool keepDisplayOn = false)
    {
        uint flags = ES_CONTINUOUS | ES_SYSTEM_REQUIRED;
        if (keepDisplayOn)
        {
            flags |= ES_DISPLAY_REQUIRED;
        }

        currentState = SetThreadExecutionState(flags);
        if (currentState == 0)
        {
            Console.WriteLine("Failed to set execution state!");
        }
    }

    public static void UnblockPowerSave()
    {
        SetThreadExecutionState(ES_CONTINUOUS);
        currentState = 0;
    }
}


namespace PositronWindows
{
    
    // MARK: - IPC Message Types
    
    public class IPCMessage
    {
        public int windowId { get; set; }
        public string command { get; set; } = "";

        [JsonConverter(typeof(IPCArgsConverter))]
        public List<string> args { get; set; } = new();
    }

    public class IPCArgsConverter : JsonConverter<List<string>>
    {
        public override List<string> Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options)
        {
            var list = new List<string>();
            using (var doc = JsonDocument.ParseValue(ref reader))
            {
                foreach (var element in doc.RootElement.EnumerateArray())
                {
                    // Keep strings as strings, but convert objects/arrays/numbers into raw JSON strings
                    if (element.ValueKind == JsonValueKind.String)
                        list.Add(element.GetString()!);
                    else
                        list.Add(element.GetRawText());
                }
            }
            return list;
        }

        public override void Write(Utf8JsonWriter writer, List<string> value, JsonSerializerOptions options)
        {
            writer.WriteStartArray();
            foreach (var item in value) writer.WriteStringValue(item);
            writer.WriteEndArray();
        }
    }

    public class IPCResponse
    {
        public int windowId { get; set; }
        public string @event { get; set; } = "";
        public Dictionary<string, string> data { get; set; } = new();
    }

    public partial class App : Application
    {

        private static void error(string message)
{
    string red = "\u001b[31m";

    bool isWarning = message.StartsWith("WARNING");

    bool isInfo = message.StartsWith("INFO");

    if (isWarning)
            {
                red = "\u001b[33m";
                message = message.Replace("WARNING: ", "");
            }

    if (isInfo)
            {
                red = "\u001b[34m";
                message = message.Replace("INFO: ", "");
            }

    string tag = isWarning ? "WARNING" : (isInfo ? "INFO" : "ERROR");

    string reset = "\u001b[0m";
    Console.WriteLine($"{red}[C# {tag}] {message}{reset}");

    if (_ipcClient != null)    {
        if (tag != "INFO") {
            _ipcClient.Send(new IPCResponse
            {
                windowId = -1,
                @event = "nativeError",
                data = new() { { "message", message }, { "type", tag } }
            });
        }
    } else
            {
                Console.WriteLine($"{red}[C# ERROR] No IPC client available to send error message over. {reset}");
            }
}

        private static readonly string AuthToken = 
            Environment.GetEnvironmentVariable("POSITRON_AUTH_TOKEN") ?? Guid.NewGuid().ToString();

        public static bool IsPackaged { get; private set; } = false;

        public static IPCClient _ipcClient = null!;
        private static Process? _nodeProcess;

        public static readonly Dictionary<int, Window> WindowsMap = new();
        private static readonly Dictionary<int, DockPanel> LayoutMap = new();
        private static readonly Dictionary<int, Menu> MenuMap = new();
        private static readonly HashSet<int> _forceClosing = new();
        private static readonly Dictionary<int, TaskCompletionSource> ReadyMap = new();

        [STAThread]
        public static void Main()
        {
            var app = new App();
            app.Run();
        }

        public static int GetRandomOpenPort()
{
    // Passing 0 to the port tells the OS to assign an available one
    TcpListener listener = new(IPAddress.Loopback, 0);
    listener.Start();
    int port = ((IPEndPoint)listener.LocalEndpoint).Port;
    listener.Stop();
    return port;
}

        protected override async void OnStartup(StartupEventArgs e)
        {
            base.OnStartup(e);
            this.ShutdownMode = ShutdownMode.OnExplicitShutdown;

            string basePath = AppDomain.CurrentDomain.BaseDirectory;
            string targetDir = Directory.Exists(Path.Combine(basePath, "resources"))
                ? Path.Combine(basePath, "resources")
                : basePath;

            string backendExeName = "positron-backend.exe";
            if (Directory.Exists(targetDir)) {
                string[] files = Directory.GetFiles(targetDir, "*-backend.exe");
                if (files.Length > 0) {
                    backendExeName = Path.GetFileName(files[0]);
                }
            }

            if (File.Exists(Path.Combine(targetDir, backendExeName)))
            {
                // PACKAGED MODE — C# is the entry point; launch the Node backend
                StartNodeProcess(targetDir, backendExeName);
            }
            else
            {
                // DEV MODE — Node launched us; read the port it set in the environment
                var envPort = Environment.GetEnvironmentVariable("POSITRON_IPC_PORT");
                if (!string.IsNullOrEmpty(envPort) && int.TryParse(envPort, out var port))
                {
                    _ipcPort = port;
                    error("INFO: Dev mode — connecting to existing Node IPC server on port " + port);
                }
                else
                {
                    error($"No {backendExeName} found and POSITRON_IPC_PORT not set. Cannot start.");
                    Shutdown();
                    return;
                }
            }

            Console.CancelKeyPress += (sender, e) =>
            {
                try { Current.Shutdown(); } catch { }
                try { _nodeProcess?.Kill(); } catch { }
                error("INFO: Received SIGINT, shutting down…");
            };
            
            AppDomain.CurrentDomain.ProcessExit += (sender, e) =>
            {
                Current.Dispatcher.Invoke(() =>
                {
                    try { Current.Shutdown(); } catch { }
                    try { _nodeProcess?.Kill(); } catch { }
                    error("INFO: Process exiting, shutting down…");
                });
            };

            await Task.Delay(500);
            _ipcClient = new IPCClient(new Uri($"ws://127.0.0.1:{_ipcPort}"));
            _ = _ipcClient.ConnectAsync(AuthToken);
        }

        protected override void OnExit(ExitEventArgs e)
        {
            try { _nodeProcess?.Kill(); } catch { }
            base.OnExit(e);
        }

private static int _ipcPort = 9000;

private void StartNodeProcess(string workingDirectory, string backendExeName)
{
    IsPackaged = true;

    _ipcPort = GetRandomOpenPort();

    string backendExe = Path.Combine(workingDirectory, backendExeName);

    _nodeProcess = new Process
    {
        StartInfo = new ProcessStartInfo
        {
            FileName = backendExe,
            Arguments = "",
            WorkingDirectory = workingDirectory,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = true,
            EnvironmentVariables =
            {
                ["POSITRON_PACKAGED"] = "true",
                ["POSITRON_AUTH_TOKEN"] = AuthToken,
                ["POSITRON_IPC_PORT"] = _ipcPort.ToString()
            }
        }
    };

    _nodeProcess.OutputDataReceived += (s, args) =>
    {
        if (args.Data != null) Console.WriteLine($"[NODE BACKGROUND] {args.Data}");
    };
    _nodeProcess.ErrorDataReceived += (s, args) =>
    {
        if (args.Data != null) Console.WriteLine($"[NODE BACKGROUND ERROR] {args.Data}");
    };

    _nodeProcess.Exited += (s, args) =>
    {
        error("INFO: Node process exited. Shutting down app.");
        Current.Dispatcher.Invoke(() =>
        {
            try { Current.Shutdown(); } catch { }
        });
    };

    try
    {
        _nodeProcess.Start();
        _nodeProcess.BeginOutputReadLine();
        _nodeProcess.BeginErrorReadLine();
    }
    catch (Exception ex)
    {
        error($"Failed to start Node process: {ex.Message}");
    }
}
  
        // MARK: - Command Handler

        public static async Task HandleCommandAsync(int windowId, string command, List<string> args)
        {
            // For commands other than createWindow, wait until the window's WebView2 is fully ready
            if (command != "createWindow" && ReadyMap.TryGetValue(windowId, out var tcs))
            {
                await tcs.Task;
            }

            switch (command)
            {
                case "createWindow":
                {
                    int width  = args.Count > 0 && int.TryParse(args[0], out var w) ? w : 800;
                    int height = args.Count > 1 && int.TryParse(args[1], out var h) ? h : 600;

                    var window = new Window
                    {
                        Width = width,
                        Height = height,
                        MinWidth = 200,
                        MinHeight = 150,
                        Title = "Positron Window",
                        WindowStartupLocation = WindowStartupLocation.CenterScreen
                    };

                    var dockPanel = new DockPanel();
                    var webView   = new WebView2();

                    dockPanel.Children.Add(webView);
                    DockPanel.SetDock(webView, Dock.Bottom);
                    window.Content = dockPanel;

                    // Intercept the close button — ask Node first
                    window.Closing += (s, cancelArgs) =>
                    {
                        if (_forceClosing.Remove(windowId))
                            return; // Allow the close (forceCloseWindow was called)

                        cancelArgs.Cancel = true;
                        _ipcClient.Send(new IPCResponse
                        {
                            windowId = windowId,
                            @event = "window-close-requested"
                        });
                    };

                    // Clean up after the window is actually destroyed (single subscription)
                    window.Closed += (s, e) =>
                    {
                        WindowsMap.Remove(windowId);
                        LayoutMap.Remove(windowId);
                        MenuMap.Remove(windowId);
                        ReadyMap.Remove(windowId);
                        _ipcClient.Send(new IPCResponse { windowId = windowId, @event = "windowClosed" });

                        if (WindowsMap.Count == 0)
                            Application.Current.Shutdown();
                    };

                    WindowsMap[windowId] = window;
                    LayoutMap[windowId]  = dockPanel;

                    // Create a readiness gate — other commands for this window will await it
                    var readyTcs = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
                    ReadyMap[windowId] = readyTcs;

                    window.Show();

                    // Init WebView2 & inject preload script
                    await webView.EnsureCoreWebView2Async();
                    webView.CoreWebView2.Settings.AreDevToolsEnabled = !IsPackaged;
                    await webView.CoreWebView2.AddScriptToExecuteOnDocumentCreatedAsync(MakePreloadScript(windowId));

                    // Sync window title with page title
                    webView.CoreWebView2.DocumentTitleChanged += (s, _) =>
                    {
                        window.Title = webView.CoreWebView2.DocumentTitle;
                    };

                    webView.CoreWebView2.NavigationCompleted += (s, e) =>
                    {
                        bool isFile = webView.Source != null && webView.Source.IsFile;
                        string eventName = isFile ? $"loadFile-reply-{windowId}" : $"loadURL-reply-{windowId}";
                        if (e.IsSuccess) {
                            _ipcClient.Send(new IPCResponse
                            {
                                windowId = windowId,
                                @event = eventName,
                                data = new() { { "url", webView.Source?.ToString() ?? "" }, { "title", webView.CoreWebView2.DocumentTitle }, { "canGoBack", webView.CoreWebView2.CanGoBack.ToString().ToLower() }, { "canGoForward", webView.CoreWebView2.CanGoForward.ToString().ToLower() } }
                            });
                        } else {
                            error($"Navigation failed: {e.WebErrorStatus}");
                        }
                    };

            webView.CoreWebView2.ContextMenuRequested += (s, e) =>
{
    if (LayoutMap.TryGetValue(windowId, out var l) && l.ContextMenu != null)
    {
        e.Handled = true; 
        l.ContextMenu.IsOpen = true; 
    }
};

                    // WebView → C# IPC routing
                    webView.CoreWebView2.WebMessageReceived += (s, e) =>
                    {
                        HandleWebViewIPC(windowId, e.WebMessageAsJson);
                    };

                    // Signal that this window is fully ready for commands
                    readyTcs.TrySetResult();
                    break;
                }


 case "setContextMenu":               
    if (!LayoutMap.TryGetValue(windowId, out var layout)) break;
    if (args.Count == 0)
    {
        error("setContextMenu — missing menu descriptor argument");
        break;
    }

    // 1. Parse the JSON string sent from Node
    var ctxDescriptor = JsonSerializer.Deserialize<JsonArray>(args[0]);
    if (ctxDescriptor == null)
    {
        error("setContextMenu — invalid JSON descriptor");
        break;
    }

    // 2. Build the context menu using our helper
    var contextMenu = new ContextMenu();
    PopulateMenu(contextMenu.Items, ctxDescriptor, windowId, "context-menu-action");
    
    // 3. Attach it to the layout
    layout.ContextMenu = contextMenu;
    break;

    case "setSwipeNav":
    if (!WindowsMap.TryGetValue(windowId, out var winSwipeNav)) break;
    var wvSwipeNav = GetWebView(windowId);
    if (wvSwipeNav != null)    {
        bool enable = args.Count == 0 || args[0].ToLower() != "false";
        wvSwipeNav.CoreWebView2.Settings.IsSwipeNavigationEnabled = enable;
    }
    
    GetIPCClient().Send(new IPCResponse
    {
        windowId = windowId,
        @event = args[^1] ?? "setSwipeNav-reply-" + windowId,
        data = new() { { "enabled", (wvSwipeNav?.CoreWebView2.Settings.IsSwipeNavigationEnabled ?? false).ToString().ToLower() } }
    });

    break;

    case "blockPowerSave":
    PowerSaveBlocker.BlockPowerSave();
    break;

    case "unblockPowerSave":
    PowerSaveBlocker.UnblockPowerSave();
    break;

    case "isDarkMode":
    bool isLightTheme = true;
using (RegistryKey? key = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize"))
{
    if (key != null)
    {
        object? value = key?.GetValue("AppsUseLightTheme");
        if (value != null && (int)value == 0)
        {
            isLightTheme = false; // Dark Mode
        }
    }
}
GetIPCClient().Send(new IPCResponse
{
    windowId = windowId,
    @event = args[^1] ?? "isDarkMode-reply-" + windowId,
    data = new() { { "isDarkMode", (!isLightTheme).ToString().ToLower() } }
});
break;

    case "isSwipeNavEnabled":
    if (!WindowsMap.TryGetValue(windowId, out var winCheckSwipe)) break;
    var wvCheckSwipe = GetWebView(windowId);
    if (wvCheckSwipe != null)    {
        bool isEnabled = wvCheckSwipe.CoreWebView2.Settings.IsSwipeNavigationEnabled;
        GetIPCClient().Send(new IPCResponse
        {
            windowId = windowId,
            @event = args[^1] ?? "isSwipeNavEnabled-reply-" + windowId,
            data = new() { { "enabled", isEnabled.ToString().ToLower() } }
        }
        );
    }
    break;

    case "showFileOpenDialog":
    {
        var dialog = new Microsoft.Win32.OpenFileDialog
        {
            Multiselect = args.Count > 0 && args[0].ToLower() == "true"
        };
        bool? result = dialog.ShowDialog();
        if (result == true)
        {
            string[] files = dialog.FileNames;
            GetIPCClient().Send(new IPCResponse
            {
                windowId = windowId,
                @event = args[^1] ?? "showFileOpenDialog-reply-" + windowId,
                data = new() { { "files", JsonSerializer.Serialize(files) } }
            });
        }
    }
    break;

    case "readFromClipboard":
    string clipboardText = "";
    Current.Dispatcher.Invoke(() =>
    {
        try
        {
            clipboardText = Clipboard.GetText();
        }
        catch (Exception ex)
        {
            error($"readFromClipboard failed: {ex.Message}");
        }
    });
    GetIPCClient().Send(new IPCResponse
    {
        windowId = windowId,
        @event = args[^1] ?? "readFromClipboard-reply-" + windowId,
        data = new() { { "text", clipboardText } }
    });
    break;

    case "writeToClipboard":
    if (args.Count == 0) break;
    Current.Dispatcher.Invoke(() =>
    {
        try
        {
            Clipboard.SetText(args[0]);
        }
        catch (Exception ex)
        {
            error($"writeToClipboard failed: {ex.Message}");
        }
    });
    break;

    case "isVisible":
    if (!WindowsMap.TryGetValue(windowId, out var winVisible)) break;
    bool isVisible = winVisible.IsVisible;
    GetIPCClient().Send(new IPCResponse
    {        windowId = windowId,
        @event = args[^1] ?? "isVisible-reply-" + windowId,
        data = new() { { "isVisible", isVisible.ToString().ToLower() } }
    });
    break;

    case "isFullscreen":
    if (!WindowsMap.TryGetValue(windowId, out var winFullscreen)) break;
    bool isFullscreen = winFullscreen.WindowState == WindowState.Maximized;
    GetIPCClient().Send(new IPCResponse
    {        windowId = windowId,
        @event = args[^1] ?? "isFullscreen-reply-" + windowId,
        data = new() { { "isFullscreen", isFullscreen.ToString().ToLower() } }
    });
    break;

                case "closeWindow":
                    if (WindowsMap.TryGetValue(windowId, out var winToClose))
                    {
                        _forceClosing.Add(windowId);
                        winToClose.Close(); // Triggers Closed → cleanup above
                    }
                    else
                        error($"closeWindow — no window found with ID {windowId}");
                    break;

                case "terminate":
                    try { Current.Shutdown(); } catch { }
                    break;

                    case "triggerCloseSequence":
    if (WindowsMap.TryGetValue(windowId, out var winTrigger))
    {
        // This fires the window.Closing event handler we set up above
        winTrigger.Close(); 
    }
    break;

case "forceCloseWindow":
    if (WindowsMap.TryGetValue(windowId, out var winForce))
    {
        _forceClosing.Add(windowId);
        winForce.Close();
    }
    else
    {
        error($"forceCloseWindow — no window found with ID {windowId}");
    }
    break;

                case "setTitle":
                    if (!WindowsMap.TryGetValue(windowId, out var winTitle)) break;
                    if (args.Count == 0)
                    {
                        error("setTitle — missing title argument");
                        break;
                    }
                    winTitle.Title = args[0];
                    break;

                case "resize":
                    if (!WindowsMap.TryGetValue(windowId, out var winSize)) break;
                    if (args.Count < 2 || !int.TryParse(args[0], out var newW) || !int.TryParse(args[1], out var newH))
                    {
                        error("resize — expected two integer arguments");
                        break;
                    }
                    winSize.Width  = newW;
                    winSize.Height = newH;
                    break;

                case "loadURL":
                    if (!WindowsMap.TryGetValue(windowId, out _)) break;
                    if (args.Count == 0 || !Uri.TryCreate(args[0], UriKind.Absolute, out var loadUrlUri))
                    {
                        error("loadURL — invalid or missing URL");
                        break;
                    }
                    if (loadUrlUri.Scheme != Uri.UriSchemeHttp && loadUrlUri.Scheme != Uri.UriSchemeHttps && loadUrlUri.Scheme != Uri.UriSchemeFile)
                    {
                        error($"loadURL — blocked unauthorized URL scheme: {loadUrlUri.Scheme}");
                        break;
                    }
                    {
                        var wv = GetWebView(windowId);
                        if (wv != null) wv.Source = loadUrlUri;
                    }
                    break;

                case "addToContentBlocker":
                    _ipcClient.Send(new IPCResponse
                    {
                        windowId = windowId,
                        @event = args[^1] ?? "addToContentBlocker-reply-" + windowId,
                        data = new() { { "status", "success" }, { "warning", "Content blocker not supported on Windows." } }
                    });
                    break;

                case "loadFile":
                    if (!WindowsMap.TryGetValue(windowId, out _)) break;
                    if (args.Count == 0)
                    {
                        error("loadFile — missing path argument");
                        break;
                    }
                    {
                        var wv = GetWebView(windowId);
                        if (wv != null) wv.Source = new Uri(Path.GetFullPath(args[0]));
                    }
                    break;

                    case "print":
                        {
                            var wv = GetWebView(windowId);
                            if (wv != null && wv.CoreWebView2 != null)
                                wv.CoreWebView2.ShowPrintUI();
                        }
                        break;

                    case "setUserAgent":
                        if (args.Count == 0)
                        {
                            error("setUserAgent — missing user agent string argument");
                            break;
                        }
                        {
                            var wv = GetWebView(windowId);
                            if (wv != null && wv.CoreWebView2 != null)
                                wv.CoreWebView2.Settings.UserAgent = args[0];
                        }
                        break;

                case "evaluateJS":
                    if (args.Count == 0)
                    {
                        error("evaluateJS — missing script argument");
                        break;
                    }
                    {
                        var wv = GetWebView(windowId);
                        if (wv != null)
                        {
                            try
                            {
                                var result = await wv.ExecuteScriptAsync(args[0]);
                                _ipcClient.Send(new IPCResponse
                                {
                                    windowId = windowId,
                                    @event = args[^1] ?? "evaluateJS-reply-" + windowId,
                                    data = new() { { "result", result ?? "null" } }
                                });
                            }
                            catch (Exception ex)
                            {
                                error($"evaluateJS failed: {ex.Message}");
                                _ipcClient.Send(new IPCResponse
                                {
                                    windowId = windowId,
                                    @event = args[^1] ??  "evaluateJS-reply-" + windowId,
                                    data = new() { { "error", ex.Message } }
                                });
                            }
                        }
                    }
                    break;

                case "isFocused":
                    if (!WindowsMap.TryGetValue(windowId, out var winFocusState)) break;
                    bool isFocused = winFocusState.IsActive;
                    _ipcClient.Send(new IPCResponse
                    {
                        windowId = windowId,
                        @event = args[^1] ?? "isFocused-reply-" + windowId,
                        data = new() { { "isFocused", isFocused.ToString().ToLower() } }
                    });
                    break;

                case "getFocusedWindowId":
                    int focusedWindowId = WindowsMap.FirstOrDefault(kv => kv.Value.IsActive).Key;
                    _ipcClient.Send(new IPCResponse
                    {
                        windowId = windowId,
                        @event = args[^1] ?? "getFocusedWindowId-reply-" + windowId,
                        data = new() { { "focusedWindowId", focusedWindowId.ToString() } }
                    });
                    break;

                case "showNotification":
                    if (args.Count < 2)
                    {
                        error("showNotification — expected title and body arguments");
                        break;
                    }
                    {
                        var title = args[0];
                        var body  = args[1];
                        var notification = new System.Windows.Forms.NotifyIcon
                        {
                            Visible = true,
                            Icon = System.Drawing.SystemIcons.Application,
                            BalloonTipTitle = title,
                            BalloonTipText = body
                        };
                        notification.ShowBalloonTip(3000);
                    }
                    break;

                    case "alert":
    if (args.Count == 0) break;
    MessageBox.Show(args[0], "", MessageBoxButton.OK, MessageBoxImage.None);
    break;

// Node uses "resizeWindow", not "resize"
case "resizeWindow":
    if (!WindowsMap.TryGetValue(windowId, out var winRsz)) break;
    if (args.Count < 2 || !int.TryParse(args[0], out var rsW) || !int.TryParse(args[1], out var rsH)) break;
    winRsz.Width = rsW;
    winRsz.Height = rsH;
    break;

// Node uses "hideWindow"/"showWindow", not "hide"/"show"
case "hideWindow":
    if (WindowsMap.TryGetValue(windowId, out var winHideW)) winHideW.Hide();
    break;

case "showWindow":
    if (WindowsMap.TryGetValue(windowId, out var winShowW)) winShowW.Show();
    break;

case "addUserScript":
    if (args.Count == 0) break;
    {
        var wv = GetWebView(windowId);
        if (wv?.CoreWebView2 != null)
            await wv.CoreWebView2.AddScriptToExecuteOnDocumentCreatedAsync(args[0]);
    }
    break;

case "setCloseable":
    // WPF doesn't support disabling the close button cleanly; silently ignore
    break;

case "setResizable":
    if (WindowsMap.TryGetValue(windowId, out var winRes))
        winRes.ResizeMode = args[0] == "true" ? ResizeMode.CanResize : ResizeMode.NoResize;
    break;

case "setMinimizable":
    // No direct WPF equivalent; silently ignore
    break;

case "setBounds":
    if (!WindowsMap.TryGetValue(windowId, out var winBounds)) break;
    if (args.Count < 4) break;
    if (double.TryParse(args[0], out var bx)) winBounds.Left = bx;
    if (double.TryParse(args[1], out var by)) winBounds.Top = by;
    if (double.TryParse(args[2], out var bw)) winBounds.Width = bw;
    if (double.TryParse(args[3], out var bh)) winBounds.Height = bh;
    break;


                case "prompt":
                    if (args.Count < 2)
                    {
                        error("prompt — expected message and defaultValue arguments");
                        break;
                    }
                    {
                        var message = args[0];
                        var defaultValue = args[1];
                        string result = Interaction.InputBox(message, "Prompt", defaultValue);
                        _ipcClient.Send(new IPCResponse
                        {
                            windowId = windowId,
                            @event = args[^1] ?? "prompt-reply-" + windowId,
                            data = new() { { "input", result } }
                        });
                    }
                    break;

                case "confirm":
                    if (args.Count < 1)
                    {
                        error("confirm — expected message argument");
                        break;
                    }
                    {
                        var message = args[0];
                        var result = MessageBox.Show(message, "Confirm", MessageBoxButton.YesNo) == MessageBoxResult.Yes;
                        _ipcClient.Send(new IPCResponse
                        {
                            windowId = windowId,
                            @event = args[^1] ?? "confirm-reply-" + windowId,
                            data = new() { { "confirmed", result.ToString().ToLower() } }
                        });
                    }
                    break;

                case "emitToRenderer":
                    if (args.Count < 2)
                    {
                        error("emitToRenderer — expected channel and payload arguments");
                        break;
                    }
                    {
                        var channel = args[0];
                        var payload = args[1];
                        var escaped = payload
                            .Replace("\\", "\\\\")
                            .Replace("`", "\\`");
                        var script = $"window.ipc._emit(`{channel}`, JSON.parse(`{escaped}`));";
                        var wv = GetWebView(windowId);
                        if (wv != null)
                        {
                            try { await wv.ExecuteScriptAsync(script); }
                            catch (Exception ex) { error($"emitToRenderer failed: {ex.Message}"); }
                        }
                    }
                    break;

                case "setMenu":
                    if (args.Count == 0)
                    {
                        error("setMenu — missing menu descriptor argument");
                        break;
                    }
                    BuildAndAttachMenu(windowId, args[0]);
                    break;

                case "resetMenu":
                    RemoveMenu(windowId);
                    break;

                case "openDevTools":
                    {
                        var wv = GetWebView(windowId);
                        if (wv != null && wv.CoreWebView2 != null)
                            wv.CoreWebView2.OpenDevToolsWindow();
                    }
                    break;

                    case "hide":
                        if (WindowsMap.TryGetValue(windowId, out var winHide))
                            winHide.Hide();
                        break;

                    case "show":
                        if (WindowsMap.TryGetValue(windowId, out var winShow))                           
                             winShow.Show();
                        break; 

                case "minimize":
                    if (WindowsMap.TryGetValue(windowId, out var winMin))
                        winMin.WindowState = WindowState.Minimized;
                    break;

                case "maximize":
                    if (WindowsMap.TryGetValue(windowId, out var winMax))
                        winMax.WindowState = WindowState.Maximized;
                    break;

                    case "focus":
                        if (WindowsMap.TryGetValue(windowId, out var winFocus))
                            winFocus.Focus();
                        break;

                    case "fullscreen":
                        if (WindowsMap.TryGetValue(windowId, out var winFS))
                            winFS.WindowState = WindowState.Maximized;
                        break;

                    case "exitFullscreen":
                        if (WindowsMap.TryGetValue(windowId, out var winExitFS))
                            winExitFS.WindowState = WindowState.Normal;
                        break;

                    case "toggleFullscreen":
                        if (WindowsMap.TryGetValue(windowId, out var winToggleFS))
                            winToggleFS.WindowState = winToggleFS.WindowState == WindowState.Maximized ? WindowState.Normal : WindowState.Maximized;
                        break;

                    case "forward":
                        {
                            var wv = GetWebView(windowId);
                            if (wv != null && wv.CoreWebView2 != null && wv.CoreWebView2.CanGoForward)
                                wv.CoreWebView2.GoForward();
                        }
                        break;

                    case "back":
                        {
                            var wv = GetWebView(windowId);
                            if (wv != null && wv.CoreWebView2 != null && wv.CoreWebView2.CanGoBack)
                                wv.CoreWebView2.GoBack();
                        }
                        break;

                    case "reload":
                        {
                            var wv = GetWebView(windowId);
                            if (wv != null && wv.CoreWebView2 != null)
                                wv.CoreWebView2.Reload();
                        }
                        break;

                case "capturePage":
                    {
                        var wv = GetWebView(windowId);
                        if (wv != null)
                        {
                            try
                            {
                                using var ms = new MemoryStream();
                                await wv.CoreWebView2.CapturePreviewAsync(CoreWebView2CapturePreviewImageFormat.Png, ms);
                                var base64 = Convert.ToBase64String(ms.ToArray());
                                _ipcClient.Send(new IPCResponse
                                {
                                    windowId = windowId,
                                    @event = args[^1] ?? "capture-page-result-" + windowId,
                                    data = new() { { "imageData", base64 } }
                                });
                            }
                            catch (Exception ex)
                            {
                                error($"capturePage failed: {ex.Message}");
                            }
                        }
                    }
                    break;

                case "canGoBack":
                    {
                        var wv = GetWebView(windowId);
                        if (wv != null && wv.CoreWebView2 != null)
                        {
                            bool canGoBack = wv.CoreWebView2.CanGoBack;
                            _ipcClient.Send(new IPCResponse
                            {
                                windowId = windowId,
                                @event = args[^1] ?? "canGoBack-reply-" + windowId,
                                data = new() { { "canGoBack", canGoBack.ToString().ToLower() } }
                            });
                        }
                    }
                    break;

                    case "canGoForward":
                    {
                        var wv = GetWebView(windowId);
                        if (wv != null && wv.CoreWebView2 != null)
                        {
                            bool canGoForward = wv.CoreWebView2.CanGoForward;
                            _ipcClient.Send(new IPCResponse
                            {
                                windowId = windowId,
                                @event = args[^1] ?? "canGoForward-reply-" + windowId,
                                data = new() { { "canGoForward", canGoForward.ToString().ToLower() } }
                            });
                        }
                    }
                    break;

                case "getURL":
                    {
                        var wv = GetWebView(windowId);
                        if (wv != null && wv.CoreWebView2 != null)
                        {
                            string url = wv.CoreWebView2.Source;
                            _ipcClient.Send(new IPCResponse
                            {
                                windowId = windowId,
                                @event = args[^1] ?? "getURL-reply-" + windowId,
                                data = new() { { "url", url } }
                            });
                        }
                    }
                    break;

                    case "getTitle":
                    {
                        var wv = GetWebView(windowId);
                        if (wv != null && wv.CoreWebView2 != null)
                        {
                            string title = wv.CoreWebView2.DocumentTitle;
                            _ipcClient.Send(new IPCResponse
                            {
                                windowId = windowId,
                                @event = args[^1] ?? "getTitle-reply-" + windowId,
                                data = new() { { "title", title } }
                            });
                        }
                    }
                    break;


                default:
                    Console.WriteLine($"[C#] Received command: {command} with args: {string.Join(", ", args)}");
                    var registry = ExtensionRegistry.GetExtensions();
                    if (registry.TryGetValue(command, out var handler))
                        handler(windowId, args);
                    else
                        error($"Unknown command '{command}' for window {windowId}");
                    break;
            }
        }

        public static WebView2? GetWebView(int windowId)
        {
            if (LayoutMap.TryGetValue(windowId, out var layout))
            {
                foreach (var child in layout.Children)
                {
                    if (child is WebView2 wv) return wv;
                }
            }
            return null;
        }

        public static Window? GetWindow(int windowId)
        {
            if (WindowsMap.TryGetValue(windowId, out var window))
                return window;
            return null;
        }

        public static IPCClient GetIPCClient() => _ipcClient;

        // MARK: - Menu Management

        private static void BuildAndAttachMenu(int windowId, string jsonStr)
        {
            if (!LayoutMap.TryGetValue(windowId, out var layout)) return;

            RemoveMenu(windowId); // Clear old menu if any

            var descriptor = JsonSerializer.Deserialize<List<JsonNode>>(jsonStr);
            if (descriptor == null)
            {
                error("setMenu — invalid JSON descriptor");
                return;
            }

            var menu = new Menu();
            DockPanel.SetDock(menu, Dock.Top);

            foreach (var topLevel in descriptor)
            {
                var topItem = new MenuItem { Header = topLevel["label"]?.ToString() ?? "" };
                menu.Items.Add(topItem);

                var items = topLevel["items"]?.AsArray();
                if (items != null)
                    PopulateMenu(topItem.Items, items, windowId, "menu-action");
            }

            layout.Children.Insert(0, menu); // Push menu to top of layout
            MenuMap[windowId] = menu;
        }

  internal static void PopulateMenu(ItemCollection parentItems, JsonArray items, int windowId, string eventType = "menu-action")
{
    foreach (var item in items)
    {
        if (item?["separator"]?.GetValue<bool>() == true)
        {
            parentItems.Add(new Separator());
            continue;
        }

        var label   = item?["label"]?.ToString()            ?? "(untitled)";
        var channel = item?["channel"]?.ToString()          ?? "";
        var payload = item?["payload"]?.ToString()          ?? "null";
        var enabled = item?["enabled"]?.GetValue<bool>()    ?? true;

        var menuItem = new MenuItem { Header = label, IsEnabled = enabled };

        // Always attach a click handler — items with only a `click` callback (no channel)
        // still need to send an event so Node can look up the handler by label.
        menuItem.Click += (s, e) =>
        {
            _ipcClient.Send(new IPCResponse
            {
                windowId = windowId,
                @event = eventType, 
                data = new() { { "channel", channel }, { "payload", payload }, { "label", label } }
            });
        };

        var subItems = item?["items"]?.AsArray();
        if (subItems != null && subItems.Count > 0)
            PopulateMenu(menuItem.Items, subItems, windowId, eventType);

        parentItems.Add(menuItem);
    }
}
  
        private static void RemoveMenu(int windowId)
        {
            if (MenuMap.TryGetValue(windowId, out var menu) && LayoutMap.TryGetValue(windowId, out var layout))
            {
                layout.Children.Remove(menu);
                MenuMap.Remove(windowId);
            }
        }

        // MARK: - WebView IPC Handler

        /// <summary>
        /// Receives messages from renderer JS: window.chrome.webview.postMessage({...})
        /// and forwards them upstream to Node over the WebSocket.
        /// </summary>
        private static void HandleWebViewIPC(int windowId, string rawJson)
        {
            try
            {
                var doc     = JsonSerializer.Deserialize<JsonNode>(rawJson);
                var channel = doc?["channel"]?.ToString();

                if (channel == null)
                {
                    error($"WebView IPC message malformed (windowId {windowId}): {rawJson}");
                    return;
                }

                // Serialise payload back to a JSON string so it travels cleanly over the WebSocket
                var payloadNode   = doc?["payload"];
                string payloadStr = payloadNode?.ToJsonString() ?? "null";

                _ipcClient.Send(new IPCResponse
                {
                    windowId = windowId,
                    @event = "ipcMessage",
                    data = new() { { "channel", channel }, { "payload", payloadStr } }
                });
            }
            catch (Exception ex)
                {
                    error($"Failed to handle WebView IPC message: {ex.Message}");
            }
        }

        // MARK: - Preload Script

        private static string MakePreloadScript(int windowId)
        {
            return $@"(function () {{
  if (window.__ipcInstalled) return;
  window.__ipcInstalled = true;

  const _listeners = {{}};

  window.ipc = {{
    /** Send a message to the Node/C# backend.
     *  @param {{string}} channel
     *  @param {{*}}      payload  — must be JSON-serialisable
     */
    send(channel, payload = null) {{
      if (typeof channel !== 'string') {{
        console.warn('[ipc] send() failed: channel must be a string');
        return;
      }}
      if (!payload) payload = {{}};
      window.chrome.webview.postMessage({{ channel, payload }});
    }},

    /** Listen for a message pushed from the backend via ipc.emit().
     *  @param {{string}}   channel
     *  @param {{Function}} listener
     */
    on(channel, listener) {{
      if (!_listeners[channel]) _listeners[channel] = [];
      _listeners[channel].push(listener);
    }},

    /** Remove a previously registered listener. */
    off(channel, listener) {{
      if (!_listeners[channel]) return;
      _listeners[channel] = _listeners[channel].filter(l => l !== listener);
    }},

    /** Called internally by C#'s ExecuteScriptAsync to deliver a push message. */
    _emit(channel, payload) {{
      (_listeners[channel] || []).forEach(fn => {{
        try {{ fn(payload); }} catch(e) {{ console.error('[ipc] listener error:', e); }}
      }});
    }},

    /** Window ID stamped in at injection time — useful for multi-window apps. */
    windowId: {windowId},
  }};

  console.debug('[ipc] preload ready, windowId={windowId}');
}})();";
        }
    }

    // MARK: - IPC WebSocket Client

    public class IPCClient
    {
        private readonly Uri _serverUri;
        private ClientWebSocket? _ws;
        private readonly CancellationTokenSource _cts = new();
        private int _reconnectAttempts = 0;
        private const int MaxReconnectAttempts = 10;
        private const int ReconnectDelayMs = 2000;

        public IPCClient(Uri serverUri) => _serverUri = serverUri;

       private static void error(string message)
        {
            string red = "\u001b[31m";
            string reset = "\u001b[0m";
            Console.WriteLine($"{red}[ERROR] {message}{reset}");
        }

        public async Task ConnectAsync(string authToken)
        {
            while (!_cts.IsCancellationRequested)
            {
                if (_reconnectAttempts >= MaxReconnectAttempts)
                {
                    error($"Exceeded maximum reconnect attempts ({MaxReconnectAttempts}). Giving up.");
                    Environment.Exit(1);
                }

                try
                {
                    if (_ws != null) _ws.Dispose();
                    _ws = new ClientWebSocket();
                    _ws.Options.SetRequestHeader("x-positron-auth-token", authToken);
                    error($"INFO: Connecting to IPC server (attempt {_reconnectAttempts + 1})…");
                    await _ws.ConnectAsync(_serverUri, _cts.Token);
                    _reconnectAttempts = 0;
                    error("INFO: Connected to IPC server.");
                    await ReceiveLoopAsync();
                }
                catch (Exception ex)
                { 
                    _reconnectAttempts++;
                    string errorMsg = ex.Message;
                    if (ex.InnerException != null) errorMsg += " | " + ex.InnerException.Message;

                    error($"WebSocket error: {errorMsg}. Reconnecting in {ReconnectDelayMs / 1000}s… (attempt {_reconnectAttempts}/{MaxReconnectAttempts})");
                    
                    if (errorMsg.Contains("503") || errorMsg.Contains("401") || errorMsg.Contains("403"))
                    {
                        error("Fatal connection error (Unauthorized or Port Hijacked). Exiting immediately.");
                        Environment.Exit(1);
                    }

                    await Task.Delay(ReconnectDelayMs, _cts.Token);
                }
            }
        }

        public void Send(IPCResponse response)
        {
            if (_ws == null || _ws.State != WebSocketState.Open) return;

            try
            {
                var json  = JsonSerializer.Serialize(response);
                var bytes = Encoding.UTF8.GetBytes(json);
                _ = _ws.SendAsync(new ArraySegment<byte>(bytes), WebSocketMessageType.Text, true, CancellationToken.None);
            }
            catch (Exception ex)
            {
                error($"Failed to send IPC response: {ex.Message}");
            }
        }

        private async Task ReceiveLoopAsync()
        {
            var buffer = new byte[1024 * 4];

            while (_ws?.State == WebSocketState.Open)
            {
                using var ms = new MemoryStream();
                WebSocketReceiveResult result;
                do
                {
                    result = await _ws.ReceiveAsync(new ArraySegment<byte>(buffer), _cts.Token);

                    if (result.MessageType == WebSocketMessageType.Close)
                    {
                        await _ws.CloseAsync(WebSocketCloseStatus.NormalClosure, string.Empty, _cts.Token);
                        return;
                    }

                    ms.Write(buffer, 0, result.Count);

                } while (!result.EndOfMessage);

                ms.Seek(0, SeekOrigin.Begin);
                using var reader      = new StreamReader(ms, Encoding.UTF8);
                var messageText = await reader.ReadToEndAsync();

                if (!string.IsNullOrWhiteSpace(messageText))
                    ParseAndDispatch(messageText);
            }
        }

        private void ParseAndDispatch(string text)
        {
            try
            {
                var msg = JsonSerializer.Deserialize<IPCMessage>(text);
                if (msg == null) return;

                _ = Application.Current.Dispatcher.InvokeAsync(async () =>
                {
                    try
                    {
                        await App.HandleCommandAsync(msg.windowId, msg.command, msg.args);
                    }
                    catch (Exception ex)
                    {
                        error($"Failed to handle IPC command '{msg.command}': {ex.Message}\n{ex.StackTrace}");
                    }
                });
            }
            catch (Exception ex)
            {
                error($"Failed to decode IPC message '{text}': {ex.Message}");
            }
        }
    }
}