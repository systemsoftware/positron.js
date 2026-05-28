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
using System.Windows.Input;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.Wpf;
using System.Text.Json.Serialization;
using System.Net;
using System.Net.Sockets;


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
}

        private static readonly string AuthToken = 
            Environment.GetEnvironmentVariable("POSITRON_AUTH_TOKEN") ?? Guid.NewGuid().ToString();

        public static bool IsPackaged { get; private set; } = false;

        private static IPCClient _ipcClient = null!;
        private static Process? _nodeProcess;

        /// <summary>All window access must happen on the UI thread.</summary>
        private static readonly Dictionary<int, Window> WindowsMap = new();
        private static readonly Dictionary<int, DockPanel> LayoutMap = new();
        private static readonly Dictionary<int, Menu> MenuMap = new();

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

        protected override void OnStartup(StartupEventArgs e)
        {
            base.OnStartup(e);
            this.ShutdownMode = ShutdownMode.OnExplicitShutdown;

            string basePath = AppDomain.CurrentDomain.BaseDirectory;
            string targetDir = Directory.Exists(Path.Combine(basePath, "resources"))
                ? Path.Combine(basePath, "resources")
                : basePath;

            if (File.Exists(Path.Combine(targetDir, "index.js")))
            {
                StartNodeProcess(targetDir);
            }

            Console.CancelKeyPress += (sender, e) =>
            {
                try { Current.Shutdown(); } catch { }
                try { _nodeProcess?.Kill(); } catch { }
            };
            
            AppDomain.CurrentDomain.ProcessExit += (sender, e) =>
            {
                Current.Dispatcher.Invoke(() =>
                {
                    try { Current.Shutdown(); } catch { }
                    try { _nodeProcess?.Kill(); } catch { }
                });
            };

            _ipcClient = new IPCClient(new Uri("ws://localhost:" + (Environment.GetEnvironmentVariable("POSITRON_IPC_PORT") ?? "9000")));
            _ = _ipcClient.ConnectAsync(AuthToken);
        }

        protected override void OnExit(ExitEventArgs e)
        {
            try { _nodeProcess?.Kill(); } catch { }
            base.OnExit(e);
        }

        private void StartNodeProcess(string workingDirectory)
        {
            IsPackaged = true;

            _nodeProcess = new Process
            {
                StartInfo = new ProcessStartInfo
                {
                    FileName = "cmd.exe",
                    Arguments = "/c if exist positron-backend (positron-backend) else (node .)",
                    WorkingDirectory = workingDirectory,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    EnvironmentVariables = { ["POSITRON_PACKAGED"] = "true", ["POSITRON_AUTH_TOKEN"] = AuthToken, ["POSITRON_IPC_PORT"] = GetRandomOpenPort().ToString() }
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
                    var webView  = new WebView2();

                    dockPanel.Children.Add(webView);
                    DockPanel.SetDock(webView, Dock.Bottom);
                    window.Content = dockPanel;


                    var wv = new WebView2();

wv.CoreWebView2InitializationCompleted += (sender, e) =>
{
    if (e.IsSuccess)
    {
        wv.CoreWebView2.DocumentTitleChanged += (s, args) =>
        {
            window.Title = wv.CoreWebView2.DocumentTitle;
        };
    }
};

                    // Register before Show() so the event is never missed
                    window.Closed += (s, e) =>
                    {
                        WindowsMap.Remove(windowId);
                        LayoutMap.Remove(windowId);
                        MenuMap.Remove(windowId);
                        _ipcClient.Send(new IPCResponse { windowId = windowId, @event = "windowClosed" });

                        // If all windows are closed, cleanly exit the application
                        if (WindowsMap.Count == 0)
                            Application.Current.Shutdown();
                    };

                    WindowsMap[windowId] = window;
                    LayoutMap[windowId]  = dockPanel;

                    window.Show();

                    // Init WebView2 & inject preload script
                    await webView.EnsureCoreWebView2Async();
                    webView.CoreWebView2.Settings.AreDevToolsEnabled = !IsPackaged;
                    await webView.CoreWebView2.AddScriptToExecuteOnDocumentCreatedAsync(MakePreloadScript(windowId));

                    // WebView → C# IPC routing
                    webView.CoreWebView2.WebMessageReceived += (s, e) =>
                    {
                        HandleWebViewIPC(windowId, e.WebMessageAsJson);
                    };
                    break;
                }

                case "closeWindow":
                    if (WindowsMap.TryGetValue(windowId, out var winToClose))
                        winToClose.Close(); // Triggers Closed → cleanup above
                    else
                        error($"closeWindow — no window found with ID {windowId}");
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
                    if (args.Count == 0)
                    {
                        error("loadURL — invalid or missing URL");
                        break;
                    }
                    {
                        var wv = GetWebView(windowId);
                        if (wv != null) wv.Source = new Uri(args[0]);
                    }
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
                            try { await wv.ExecuteScriptAsync(args[0]); }
                            catch (Exception ex) { error($"evaluateJS failed: {ex.Message}"); }
                        }
                    }
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
                                    @event = "capture-page-result-" + windowId,
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
                                @event = "canGoBack-reply-" + windowId,
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
                                @event = "canGoForward-reply-" + windowId,
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
                                @event = "getURL-reply-" + windowId,
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
                                @event = "getTitle-reply-" + windowId,
                                data = new() { { "title", title } }
                            });
                        }
                    }
                    break;


                default:
                    var registry = ExtensionRegistry.GetExtensions();
                    if (registry.TryGetValue(command, out var handler))
                        handler(windowId, args);
                    else
                        error($"Unknown command '{command}' for window {windowId}");
                    break;
            }
        }

        private static WebView2? GetWebView(int windowId)
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
                    PopulateMenu(topItem, items, windowId);
            }

            layout.Children.Insert(0, menu); // Push menu to top of layout
            MenuMap[windowId] = menu;
        }

        private static void PopulateMenu(MenuItem parent, JsonArray items, int windowId)
        {
            foreach (var item in items)
            {
                if (item?["separator"]?.GetValue<bool>() == true)
                {
                    parent.Items.Add(new Separator());
                    continue;
                }

                var label   = item?["label"]?.ToString()            ?? "(untitled)";
                var channel = item?["channel"]?.ToString()          ?? "";
                var payload = item?["payload"]?.ToString()          ?? "null";
                var enabled = item?["enabled"]?.GetValue<bool>()    ?? true;

                var menuItem = new MenuItem { Header = label, IsEnabled = enabled };

                if (!string.IsNullOrEmpty(channel))
                {
                    menuItem.Click += (s, e) =>
                    {
                        _ipcClient.Send(new IPCResponse
                        {
                            windowId = windowId,
                            @event = "menuAction",
                            data = new() { { "channel", channel }, { "payload", payload } }
                        });
                    };
                }

                var subItems = item?["items"]?.AsArray();
                if (subItems != null && subItems.Count > 0)
                    PopulateMenu(menuItem, subItems, windowId);

                parent.Items.Add(menuItem);
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
                    return;
                }

                try
                {
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
                    error($"WebSocket error: {ex.Message}. Reconnecting in {ReconnectDelayMs / 1000}s… (attempt {_reconnectAttempts}/{MaxReconnectAttempts})");
                    await Task.Delay(ReconnectDelayMs);
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

                Application.Current.Dispatcher.Invoke(async () =>
                {
                    try
                    {
                        await App.HandleCommandAsync(msg.windowId, msg.command, msg.args);
                    }
                    catch (Exception ex)
                    {
                        error($"Failed to decode IPC message '{text}': {ex.Message}\n{ex.StackTrace}");
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