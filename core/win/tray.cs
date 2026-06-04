using System;
using System.Collections.Generic;
using System.Windows.Controls;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Windows;
using System.Drawing;

namespace PositronWindows
{
    public class TrayManager
    {
        private static TrayManager? _shared;
        public static TrayManager Shared => _shared ??= new TrayManager();

        public System.Windows.Forms.NotifyIcon? NotifyIcon { get; private set; }
        private ContextMenu? _wpfContextMenu;

        public void SetupTray()
        {
            if (NotifyIcon == null)
            {
                NotifyIcon = new System.Windows.Forms.NotifyIcon();
                NotifyIcon.Visible = true;
                NotifyIcon.Text = "App";
                NotifyIcon.Icon = SystemIcons.Application;
                
                NotifyIcon.MouseUp += (s, e) =>
                {
                    if (e.Button == System.Windows.Forms.MouseButtons.Right || e.Button == System.Windows.Forms.MouseButtons.Left)
                    {
                        if (_wpfContextMenu != null)
                        {
                            _wpfContextMenu.IsOpen = true;
                            if (Application.Current.MainWindow != null)
                            {
                                Application.Current.MainWindow.Activate();
                            }
                        }
                    }
                };
            }
        }

        public void SetMenu(ContextMenu menu)
        {
            _wpfContextMenu = menu;
        }

        public void SetTitle(string title)
        {
            if (NotifyIcon != null && !string.IsNullOrEmpty(title))
            {
                NotifyIcon.Text = title.Length > 63 ? title.Substring(0, 63) : title;
            }
        }

        public void SetIcon(string iconPath)
        {
            if (NotifyIcon != null && !string.IsNullOrEmpty(iconPath))
            {
                try
                {
                    NotifyIcon.Icon = new Icon(iconPath);
                }
                catch (Exception ex)
                {
                    Console.WriteLine($"Failed to set tray icon: {ex.Message}");
                }
            }
        }
    }

    public static class TrayExtension
    {
        public static void Handle(int windowId, List<string> args)
        {
            if (args.Count == 0)
            {
                Console.WriteLine("tray:setMenu — missing JSON descriptor");
                return;
            }

            if (args[^1] == "setTitle")
            {
                string title = args[0];
                Application.Current.Dispatcher.Invoke(() =>
                {
                    TrayManager.Shared.SetTitle(title);
                });
                return;
            }

            if (args[^1] == "setIcon")
            {
                string iconPath = args[0];
                Application.Current.Dispatcher.Invoke(() =>
                {
                    TrayManager.Shared.SetIcon(iconPath);
                });
                return;
            }

            var descString = args[0];
            var ctxDescriptor = JsonSerializer.Deserialize<JsonArray>(descString);
            if (ctxDescriptor == null)
            {
                Console.WriteLine("tray:setMenu — invalid JSON descriptor");
                return;
            }

            if(args[^1] == "setMenu")
            {
                Application.Current.Dispatcher.Invoke(() =>
                {
                    var contextMenu = new ContextMenu();
                    App.PopulateMenu(contextMenu.Items, ctxDescriptor, windowId, "context-menu-action");
                    TrayManager.Shared.SetMenu(contextMenu);
                });
                return;
            }

            Application.Current.Dispatcher.Invoke(() =>
            {
                TrayManager.Shared.SetupTray();

                string? title = args.Count > 1 ? args[1] : "";
                TrayManager.Shared.SetTitle(title);

                string? imagePath = args.Count > 2 ? args[2] : null;
                if (imagePath != null)
                {
                    TrayManager.Shared.SetIcon(imagePath);
                }

                var contextMenu = new ContextMenu();
                App.PopulateMenu(contextMenu.Items, ctxDescriptor, windowId, "context-menu-action");
                TrayManager.Shared.SetMenu(contextMenu);
            });
        }
    }
}
