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
        private static IPCClient _ipcClient = null!;
        private static Process? _nodeProcess;
        private static readonly Dictionary<int, Window> WindowsMap = new();
        private static readonly Dictionary<int, DockPanel> LayoutMap = new();
        private static readonly Dictionary<int, Menu> MenuMap = new();

        [STAThread]
        public static void Main()
        {
            var app = new App();
            app.Run();
        }

        protected override void OnStartup(StartupEventArgs e)
        {
            base.OnStartup(e);

            this.ShutdownMode = ShutdownMode.OnExplicitShutdown;

            if (File.Exists(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "index.js")))
            {
                StartNodeProcess();
            }

            _ipcClient = new IPCClient(new Uri("ws://localhost:9000"));
            _ = _ipcClient.ConnectAsync();
        }

        protected override void OnExit(ExitEventArgs e)
        {
            try { _nodeProcess?.Kill(); } catch { }
            base.OnExit(e);
        }

        private void StartNodeProcess()
        {
            _nodeProcess = new Process();
            _nodeProcess.StartInfo = new ProcessStartInfo
            {
                FileName = "cmd.exe",
                Arguments = $"/c node index.js",
                WorkingDirectory = AppDomain.CurrentDomain.BaseDirectory,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                CreateNoWindow = true
            };

            _nodeProcess.OutputDataReceived += (s, args) => { if (args.Data != null) Console.WriteLine($"[NODE BACKGROUND] {args.Data}"); };
            _nodeProcess.ErrorDataReceived += (s, args) => { if (args.Data != null) Console.WriteLine($"[NODE BACKGROUND ERROR] {args.Data}"); };

            _nodeProcess.Start();
            _nodeProcess.BeginOutputReadLine();
            _nodeProcess.BeginErrorReadLine();
        }

        // MARK: - Command Handler
        public static async Task HandleCommandAsync(int windowId, string command, List<string> args)
        {
            switch (command)
            {
                case "createWindow":
                    int width = args.Count > 0 && int.TryParse(args[0], out var w) ? w : 800;
                    int height = args.Count > 1 && int.TryParse(args[1], out var h) ? h : 600;

                    var window = new Window
                    {
                        Width = width,
                        Height = height,
                        Title = "Positron Window",
                        WindowStartupLocation = WindowStartupLocation.CenterScreen
                    };

                    var dockPanel = new DockPanel();
                    var webView = new WebView2();

                    dockPanel.Children.Add(webView);
                    DockPanel.SetDock(webView, Dock.Bottom);
                    window.Content = dockPanel;

                    window.Closed += (s, e) =>
                    {
                        WindowsMap.Remove(windowId);
                        LayoutMap.Remove(windowId);
                        MenuMap.Remove(windowId);
                        _ipcClient.Send(new IPCResponse { windowId = windowId, @event = "windowClosed" });

                        // If all windows are closed, cleanly exit the application
                        if (WindowsMap.Count == 0)
                        {
                            Application.Current.Shutdown();
                        }
                    };

                    WindowsMap[windowId] = window;
                    LayoutMap[windowId] = dockPanel;

                    window.Show();

                    // Init WebView2 & Preload scripts
                    await webView.EnsureCoreWebView2Async();
                    await webView.CoreWebView2.AddScriptToExecuteOnDocumentCreatedAsync(MakePreloadScript(windowId));
                    
                    // WebView -> C# IPC Routing
                    webView.CoreWebView2.WebMessageReceived += (s, e) =>
                    {
                        HandleWebViewIPC(windowId, e.WebMessageAsJson);
                    };

                    window.Closed += (s, e) =>
                    {
                        WindowsMap.Remove(windowId);
                        LayoutMap.Remove(windowId);
                        MenuMap.Remove(windowId);
                        _ipcClient.Send(new IPCResponse { windowId = windowId, @event = "windowClosed" });
                    };

                    break;

                case "closeWindow":
                    if (WindowsMap.TryGetValue(windowId, out var winToClose)) winToClose.Close();
                    break;

                case "setTitle":
                    if (WindowsMap.TryGetValue(windowId, out var winTitle) && args.Count > 0)
                        winTitle.Title = args[0];
                    break;

                case "resize":
                    if (WindowsMap.TryGetValue(windowId, out var winSize) && args.Count >= 2)
                    {
                        if (int.TryParse(args[0], out var newW) && int.TryParse(args[1], out var newH))
                        {
                            winSize.Width = newW;
                            winSize.Height = newH;
                        }
                    }
                    break;

                case "loadURL":
                    if (WindowsMap.TryGetValue(windowId, out var winURL) && args.Count > 0)
                    {
                        var wv = GetWebView(windowId);
                        if (wv != null) wv.Source = new Uri(args[0]);
                    }
                    break;

                case "loadFile":
                    if (WindowsMap.TryGetValue(windowId, out var winFile) && args.Count > 0)
                    {
                        var wv = GetWebView(windowId);
                        if (wv != null) wv.Source = new Uri(Path.GetFullPath(args[0]));
                    }
                    break;

                case "evaluateJS":
                    if (args.Count > 0)
                    {
                        var wv = GetWebView(windowId);
                        if (wv != null) await wv.ExecuteScriptAsync(args[0]);
                    }
                    break;

                case "emitToRenderer":
                    if (args.Count >= 2)
                    {
                        var channel = args[0];
                        var payload = args[1];
                        var escaped = payload.Replace("\\", "\\\\").Replace("`", "\\`");
                        var script = $"window.ipc._emit(`{channel}`, JSON.parse(`{escaped}`));";
                        
                        var wv = GetWebView(windowId);
                        if (wv != null) await wv.ExecuteScriptAsync(script);
                    }
                    break;

                case "setMenu":
                    if (args.Count > 0)
                    {
                        BuildAndAttachMenu(windowId, args[0]);
                    }
                    break;

                case "resetMenu":
                    RemoveMenu(windowId);
                    break;

                default:
                    var registry = ExtensionRegistry.GetExtensions();
                    if (registry.TryGetValue(command, out var handler))
                    {
                        handler(windowId, args);
                    }
                    else
                    {
                        Console.WriteLine($"WARNING: Unknown command '{command}' for window {windowId}");
                    }
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

            var menu = new Menu();
            DockPanel.SetDock(menu, Dock.Top);

            var descriptor = JsonSerializer.Deserialize<List<JsonNode>>(jsonStr);
            if (descriptor == null) return;

            foreach (var topLevel in descriptor)
            {
                var topItem = new MenuItem { Header = topLevel["label"]?.ToString() ?? "" };
                menu.Items.Add(topItem);

                var items = topLevel["items"]?.AsArray();
                if (items != null)
                {
                    PopulateMenu(topItem, items, windowId);
                }
            }

            layout.Children.Insert(0, menu); // Push menu to top of Layout
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

                var label = item?["label"]?.ToString() ?? "";
                var channel = item?["channel"]?.ToString() ?? "";
                var payload = item?["payload"]?.ToString() ?? "null";
                var enabled = item?["enabled"]?.GetValue<bool>() ?? true;

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
                {
                    PopulateMenu(menuItem, subItems, windowId);
                }

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
        private static void HandleWebViewIPC(int windowId, string rawJson)
        {
            try
            {
                var doc = JsonSerializer.Deserialize<JsonNode>(rawJson);
                var channel = doc?["channel"]?.ToString();
                var payloadNode = doc?["payload"];
                
                if (channel == null) return;

                string payloadString = payloadNode?.ToJsonString() ?? "null";

                _ipcClient.Send(new IPCResponse
                {
                    windowId = windowId,
                    @event = "ipcMessage",
                    data = new() { { "channel", channel }, { "payload", payloadString } }
                });
            }
            catch (Exception ex)
            {
                Console.WriteLine($"Error decoding internal web message: {ex.Message}");
            }
        }

        private static string MakePreloadScript(int windowId)
        {
            return $@"
            (function () {{
              if (window.__ipcInstalled) return;
              window.__ipcInstalled = true;

              const _listeners = {{}};

              window.ipc = {{
                send(channel, payload = null) {{
                  window.chrome.webview.postMessage({{ channel, payload }});
                }},
                on(channel, listener) {{
                  if (!_listeners[channel]) _listeners[channel] = [];
                  _listeners[channel].push(listener);
                }},
                off(channel, listener) {{
                  if (!_listeners[channel]) return;
                  _listeners[channel] = _listeners[channel].filter(l => l !== listener);
                }},
                _emit(channel, payload) {{
                  (_listeners[channel] || []).forEach(fn => {{
                    try {{ fn(payload); }} catch(e) {{ console.error('[ipc] listener error:', e); }}
                  }});
                }},
                windowId: {windowId},
              }};
              console.debug('[ipc] preload ready (Windows WebView2), windowId={windowId}');
            }})();";
        }
    }

    // MARK: - IPC WebSocket Client
    public class IPCClient
    {
        private readonly Uri _serverUri;
        private ClientWebSocket? _ws;
        private readonly CancellationTokenSource _cts = new();

        public IPCClient(Uri serverUri) => _serverUri = serverUri;

        public async Task ConnectAsync()
        {
            while (!_cts.IsCancellationRequested)
            {
                try
                {
                    _ws = new ClientWebSocket();
                    Console.WriteLine("Connecting to IPC server...");
                    await _ws.ConnectAsync(_serverUri, _cts.Token);
                    Console.WriteLine("Connected to IPC server.");
                    
                    await ReceiveLoopAsync();
                }
                catch (Exception ex)
                {
                    Console.WriteLine($"WebSocket error: {ex.Message}. Reconnecting in 2s...");
                    await Task.Delay(2000);
                }
            }
        }

        public void Send(IPCResponse response)
        {
            if (_ws == null || _ws.State != WebSocketState.Open) return;

            var json = JsonSerializer.Serialize(response);
            var bytes = Encoding.UTF8.GetBytes(json);
            
            _ = _ws.SendAsync(new ArraySegment<byte>(bytes), WebSocketMessageType.Text, true, CancellationToken.None);
        }

        private async Task ReceiveLoopAsync()
        {
            var buffer = new byte[1024 * 4];
            
            while (_ws?.State == WebSocketState.Open)
            {
                using (var ms = new MemoryStream())
                {
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
                    using (var reader = new StreamReader(ms, Encoding.UTF8))
                    {
                        var messageText = await reader.ReadToEndAsync();
                        if (!string.IsNullOrWhiteSpace(messageText))
                        {
                            ParseAndDispatch(messageText);
                        }
                    }
                }
            }
        }

              private void ParseAndDispatch(string text)
        {
            try
            {
                var msg = JsonSerializer.Deserialize<IPCMessage>(text);
                if (msg != null)
                {
                    Application.Current.Dispatcher.Invoke(async () =>
                    {
                        try 
                        {
                            Console.WriteLine($"[C# DEBUG] Received command: {msg.command}");
                            await App.HandleCommandAsync(msg.windowId, msg.command, msg.args);
                        }
                        catch (Exception ex)
                        {
                            Console.WriteLine($"[C# ROUTER ERROR] Failed executing '{msg.command}': {ex.Message}\n{ex.StackTrace}");
                        }
                    });
                }
            }
            catch (Exception ex)
            {
                Console.WriteLine($"Failed to decode IPC message: {ex.Message}");
            }
        }
    }
}