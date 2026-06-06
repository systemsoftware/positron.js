#include <gtk/gtk.h>
#include <webkit2/webkit2.h>
#include <libsoup/soup.h>
#include <json-glib/json-glib.h>
#include <string>
#include <unordered_map>
#include <vector>
#include <iostream>
#include <cstdlib>
#include <sstream>
#include <fstream>
#include <climits>
#include <unistd.h>
#include <sys/types.h>
#include <sys/socket.h>
#include <netinet/in.h>
#include <signal.h>
#include <gdk/gdk.h>
#include <gdk-pixbuf/gdk-pixbuf.h>
#include <libnotify/notify.h>

using namespace std;

// ─── Globals ────────────────────────────────────────────────────────────────

struct WindowState {
    GtkWidget* window;
    WebKitWebView* webview;
};

unordered_map<int, WindowState> windowMap;
SoupWebsocketConnection* ws_conn = nullptr;
string auth_token = "";

extern unordered_map<string, void(*)(int, vector<string>)> getExtensionRegistry();

// ─── Helpers ─────────────────────────────────────────────────────────────────

static string js_escape(const string& s) {
    string out;
    out.reserve(s.size());
    for (char c : s) {
        if (c == '\\') out += "\\\\";
        else if (c == '`')  out += "\\`";
        else out += c;
    }
    return out;
}

void send_ipc(int window_id, const string& event, JsonBuilder* payload_builder) {
    if (!ws_conn) return;

    JsonNode* data_node = json_builder_get_root(payload_builder);

    JsonBuilder* root_builder = json_builder_new();
    json_builder_begin_object(root_builder);
    json_builder_set_member_name(root_builder, "windowId");
    json_builder_add_int_value(root_builder, window_id);
    json_builder_set_member_name(root_builder, "event");
    json_builder_add_string_value(root_builder, event.c_str());
    json_builder_set_member_name(root_builder, "data");
    json_builder_add_value(root_builder, data_node);
    json_builder_end_object(root_builder);

    JsonNode* root = json_builder_get_root(root_builder);
    JsonGenerator* gen = json_generator_new();
    json_generator_set_root(gen, root);
    gsize length;
    gchar* str = json_generator_to_data(gen, &length);

    soup_websocket_connection_send_text(ws_conn, str);

    g_free(str);
    g_object_unref(gen);
    json_node_free(root);
    g_object_unref(root_builder);
    g_object_unref(payload_builder);
}

void send_reply(int window_id, const string& event, const string& key, const string& val) {
    JsonBuilder* b = json_builder_new();
    json_builder_begin_object(b);
    json_builder_set_member_name(b, key.c_str());
    json_builder_add_string_value(b, val.c_str());
    json_builder_end_object(b);
    send_ipc(window_id, event, b);
}

static string get_last_arg(const vector<string>& args, const string& fallback) {
    return args.empty() ? fallback : args.back();
}

// ─── Forward-declare JS evaluation ──────────────────────────────────────────

static void evaluate_js(int window_id, const string& script);

// ─── Preload script ───────────────────────────────────────────────────────────

static string make_preload(int window_id) {
    return R"JS(
(function () {
  if (window.__ipcInstalled) return;
  window.__ipcInstalled = true;

  const _listeners = {};

  window.ipc = {
    send(channel, payload = null) {
      if (typeof channel !== 'string') { console.warn('[ipc] send() failed: channel must be a string'); return; }
      window.webkit.messageHandlers.ipc.postMessage({ channel, payload });
    },
    on(channel, fn) {
      if (!_listeners[channel]) _listeners[channel] = [];
      _listeners[channel].push(fn);
    },
    off(channel, fn) {
      if (!_listeners[channel]) return;
      _listeners[channel] = _listeners[channel].filter(f => f !== fn);
    },
    _emit(channel, payload) {
      (_listeners[channel] || []).forEach(fn => fn(payload));
    }
  };
})();
)JS";
}

// ─── WebView message callback (renderer → Node) ──────────────────────────────

static void on_script_message(WebKitUserContentManager* mgr,
                               WebKitJavascriptResult* result,
                               gpointer user_data) {
    int window_id = GPOINTER_TO_INT(user_data);

    JSCValue* val = webkit_javascript_result_get_js_value(result);
    if (!val || !jsc_value_is_object(val)) {
        webkit_javascript_result_unref(result);
        return;
    }

    JSCValue* ch_val  = jsc_value_object_get_property(val, "channel");
    JSCValue* pay_val = jsc_value_object_get_property(val, "payload");

    gchar* channel = jsc_value_to_string(ch_val);
    gchar* payload = jsc_value_is_null(pay_val) ? g_strdup("null") : jsc_value_to_json(pay_val, 0);

    JsonBuilder* b = json_builder_new();
    json_builder_begin_object(b);
    json_builder_set_member_name(b, "channel");
    json_builder_add_string_value(b, channel ? channel : "");
    json_builder_set_member_name(b, "payload");
    json_builder_add_string_value(b, payload ? payload : "null");
    json_builder_end_object(b);
    send_ipc(window_id, "ipcMessage", b);

    g_free(channel);
    g_free(payload);
    g_object_unref(ch_val);
    g_object_unref(pay_val);
    webkit_javascript_result_unref(result);
}

// ─── Navigation callbacks ─────────────────────────────────────────────────────

static void on_load_changed(WebKitWebView* webview,
                             WebKitLoadEvent event,
                             gpointer user_data) {
    if (event != WEBKIT_LOAD_FINISHED) return;

    int window_id = GPOINTER_TO_INT(user_data);
    const gchar* uri = webkit_web_view_get_uri(webview);
    bool is_file = uri && g_str_has_prefix(uri, "file://");
    string reply_event = is_file
        ? ("loadFile-reply-" + to_string(window_id))
        : ("loadURL-reply-" + to_string(window_id));

    const gchar* title = webkit_web_view_get_title(webview);
    bool can_back    = webkit_web_view_can_go_back(webview);
    bool can_forward = webkit_web_view_can_go_forward(webview);

    JsonBuilder* b = json_builder_new();
    json_builder_begin_object(b);
    json_builder_set_member_name(b, "url");    json_builder_add_string_value(b, uri ? uri : "");
    json_builder_set_member_name(b, "title");  json_builder_add_string_value(b, title ? title : "");
    json_builder_set_member_name(b, "canGoBack");    json_builder_add_string_value(b, can_back ? "true" : "false");
    json_builder_set_member_name(b, "canGoForward"); json_builder_add_string_value(b, can_forward ? "true" : "false");
    json_builder_end_object(b);
    send_ipc(window_id, reply_event, b);
}

// ─── Window close callback ────────────────────────────────────────────────────

static gboolean on_delete_event(GtkWidget* widget, GdkEvent* event, gpointer data) {
    int window_id = GPOINTER_TO_INT(data);

    JsonBuilder* b = json_builder_new();
    json_builder_begin_object(b);
    json_builder_end_object(b);
    send_ipc(window_id, "window-close-requested", b);

    // Prevent default destroy — let JS decide
    return TRUE;
}

static void on_destroy(GtkWidget* widget, gpointer data) {
    int window_id = GPOINTER_TO_INT(data);
    windowMap.erase(window_id);

    JsonBuilder* b = json_builder_new();
    json_builder_begin_object(b);
    json_builder_end_object(b);
    send_ipc(window_id, "windowClosed", b);

    if (windowMap.empty()) gtk_main_quit();
}

// ─── JS evaluation ────────────────────────────────────────────────────────────

static void evaluate_js(int window_id, const string& script) {
    auto it = windowMap.find(window_id);
    if (it == windowMap.end()) return;
#if WEBKIT_CHECK_VERSION(2, 40, 0)
    webkit_web_view_evaluate_javascript(it->second.webview, script.c_str(), -1, nullptr, nullptr, nullptr, nullptr, nullptr);
#else
    webkit_web_view_run_javascript(it->second.webview, script.c_str(), nullptr, nullptr, nullptr);
#endif
}

// ─── Screenshot callback ──────────────────────────────────────────────────────

static void on_snapshot_ready(GObject* source, GAsyncResult* res, gpointer user_data) {
    int window_id = GPOINTER_TO_INT(user_data);
    GError* error = nullptr;

    cairo_surface_t* surface = webkit_web_view_get_snapshot_finish(
        WEBKIT_WEB_VIEW(source), res, &error);

    if (error) {
        cerr << "[Linux Core] capturePage failed: " << error->message << endl;
        g_error_free(error);
        return;
    }

    // Encode to PNG in memory
    GdkPixbuf* pixbuf = gdk_pixbuf_get_from_surface(
        surface, 0, 0,
        cairo_image_surface_get_width(surface),
        cairo_image_surface_get_height(surface));
    cairo_surface_destroy(surface);

    if (!pixbuf) return;

    gchar* buffer = nullptr;
    gsize size = 0;
    gdk_pixbuf_save_to_buffer(pixbuf, &buffer, &size, "png", &error, nullptr);
    g_object_unref(pixbuf);

    if (error) { g_error_free(error); return; }

    // Base64 encode
    gchar* b64 = g_base64_encode((guchar*)buffer, size);
    g_free(buffer);

    send_reply(window_id, "capture-page-result-" + to_string(window_id), "image", b64);
    g_free(b64);
}

// ─── Context-menu builder ─────────────────────────────────────────────────────

struct MenuActionData {
    int window_id;
    string label;
    string channel;
};

static void on_menu_item_activate(GtkMenuItem* item, gpointer data) {
    auto* d = static_cast<MenuActionData*>(data);
    JsonBuilder* b = json_builder_new();
    json_builder_begin_object(b);
    json_builder_set_member_name(b, "label");   json_builder_add_string_value(b, d->label.c_str());
    json_builder_set_member_name(b, "channel"); json_builder_add_string_value(b, d->channel.c_str());
    json_builder_end_object(b);
    send_ipc(d->window_id, "context-menu-action", b);
    delete d;
}

static GtkWidget* build_context_menu(JsonArray* items, int window_id) {
    GtkWidget* menu = gtk_menu_new();
    guint len = json_array_get_length(items);
    for (guint i = 0; i < len; i++) {
        JsonObject* item = json_array_get_object_element(items, i);
        const gchar* label = json_object_get_string_member(item, "label");
        if (!label || g_strcmp0(label, "-") == 0) {
            gtk_menu_shell_append(GTK_MENU_SHELL(menu), gtk_separator_menu_item_new());
            continue;
        }
        GtkWidget* mi = gtk_menu_item_new_with_label(label);
        auto* d = new MenuActionData{ window_id, label,
            json_object_has_member(item, "channel")
                ? json_object_get_string_member(item, "channel") : "" };
        g_signal_connect(mi, "activate", G_CALLBACK(on_menu_item_activate), d);
        if (json_object_has_member(item, "items")) {
            GtkWidget* sub = build_context_menu(json_object_get_array_member(item, "items"), window_id);
            gtk_menu_item_set_submenu(GTK_MENU_ITEM(mi), sub);
        }
        gtk_menu_shell_append(GTK_MENU_SHELL(menu), mi);
    }
    gtk_widget_show_all(menu);
    return menu;
}

// ─── Command Handler ──────────────────────────────────────────────────────────

void handle_command(int window_id, const string& command, const vector<string>& args) {

    // Convenience accessors
    auto get_win = [&]() -> GtkWidget* {
        auto it = windowMap.find(window_id);
        return it != windowMap.end() ? it->second.window : nullptr;
    };
    auto get_wv = [&]() -> WebKitWebView* {
        auto it = windowMap.find(window_id);
        return it != windowMap.end() ? it->second.webview : nullptr;
    };

    // ── createWindow ──────────────────────────────────────────────────────────
    if (command == "createWindow") {
        int width      = args.size() > 0 ? stoi(args[0]) : 800;
        int height     = args.size() > 1 ? stoi(args[1]) : 600;
        bool closable  = args.size() > 2 ? args[2] == "true" : true;
        bool resizable = args.size() > 3 ? args[3] == "true" : true;
        bool minimizable = args.size() > 4 ? args[4] == "true" : true;

        GtkWidget* window = gtk_window_new(GTK_WINDOW_TOPLEVEL);
        gtk_window_set_default_size(GTK_WINDOW(window), width, height);
        gtk_window_set_resizable(GTK_WINDOW(window), resizable);

        // Minimise button
        string hints = "";
        if (!minimizable) {
            gtk_widget_realize(window);
            GdkWMFunction funcs = (GdkWMFunction)(GDK_FUNC_MOVE | GDK_FUNC_RESIZE |
                (closable ? GDK_FUNC_CLOSE : (GdkWMFunction)0));
            gdk_window_set_functions(gtk_widget_get_window(window), funcs);
        }

        // User content manager for renderer IPC
        WebKitUserContentManager* ucm = webkit_user_content_manager_new();
        g_signal_connect(ucm, "script-message-received::ipc",
                         G_CALLBACK(on_script_message), GINT_TO_POINTER(window_id));
        webkit_user_content_manager_register_script_message_handler(ucm, "ipc");

        // Inject preload
        string preload_src = make_preload(window_id);
        WebKitUserScript* preload = webkit_user_script_new(
            preload_src.c_str(),
            WEBKIT_USER_CONTENT_INJECT_ALL_FRAMES,
            WEBKIT_USER_SCRIPT_INJECT_AT_DOCUMENT_START,
            nullptr, nullptr);
        webkit_user_content_manager_add_script(ucm, preload);
        webkit_user_script_unref(preload);

        WebKitWebView* webview = WEBKIT_WEB_VIEW(
            webkit_web_view_new_with_user_content_manager(ucm));

        g_signal_connect(webview, "load-changed", G_CALLBACK(on_load_changed), GINT_TO_POINTER(window_id));
        g_signal_connect(window, "delete-event", G_CALLBACK(on_delete_event), GINT_TO_POINTER(window_id));
        g_signal_connect(window, "destroy",      G_CALLBACK(on_destroy),      GINT_TO_POINTER(window_id));

        gtk_container_add(GTK_CONTAINER(window), GTK_WIDGET(webview));
        windowMap[window_id] = { window, webview };
        gtk_widget_show_all(window);
        return;
    }

    // ── terminate ──────────────────────────────────────────────────────────────
    if (command == "terminate") { gtk_main_quit(); return; }

    // ── triggerCloseSequence ───────────────────────────────────────────────────
    if (command == "triggerCloseSequence") {
        GtkWidget* w = get_win();
        if (w) {
            // Emit delete-event so JS can intercept
            gboolean handled = FALSE;
            g_signal_emit_by_name(w, "delete-event", nullptr, &handled);
        }
        return;
    }

    // ── forceCloseWindow ──────────────────────────────────────────────────────
    if (command == "forceCloseWindow") {
        GtkWidget* w = get_win();
        if (w) {
            g_signal_handlers_disconnect_by_func(w, (gpointer)on_delete_event, GINT_TO_POINTER(window_id));
            gtk_widget_destroy(w);
            windowMap.erase(window_id);
            if (windowMap.empty()) gtk_main_quit();
        }
        return;
    }

    // ── setTitle ──────────────────────────────────────────────────────────────
    if (command == "setTitle") {
        GtkWidget* w = get_win();
        if (w && !args.empty()) gtk_window_set_title(GTK_WINDOW(w), args[0].c_str());
        return;
    }

    // ── getTitle ──────────────────────────────────────────────────────────────
    if (command == "getTitle") {
        GtkWidget* w = get_win();
        const gchar* title = w ? gtk_window_get_title(GTK_WINDOW(w)) : "";
        send_reply(window_id, get_last_arg(args, "getTitle-reply-" + to_string(window_id)), "title", title ? title : "");
        return;
    }

    // ── loadURL ───────────────────────────────────────────────────────────────
    if (command == "loadURL") {
        WebKitWebView* wv = get_wv();
        if (wv && !args.empty()) webkit_web_view_load_uri(wv, args[0].c_str());
        return;
    }

    // ── loadFile ──────────────────────────────────────────────────────────────
    if (command == "loadFile") {
        WebKitWebView* wv = get_wv();
        if (wv && !args.empty()) {
            string file_uri = "file://" + args[0];
            webkit_web_view_load_uri(wv, file_uri.c_str());
        }
        return;
    }

    // ── getURL ────────────────────────────────────────────────────────────────
    if (command == "getURL") {
        WebKitWebView* wv = get_wv();
        const gchar* uri = wv ? webkit_web_view_get_uri(wv) : "";
        send_reply(window_id, get_last_arg(args, "getURL-reply-" + to_string(window_id)), "url", uri ? uri : "");
        return;
    }

    // ── hideWindow ────────────────────────────────────────────────────────────
    if (command == "hideWindow" || command == "hide") {
        GtkWidget* w = get_win();
        if (w) gtk_widget_hide(w);
        return;
    }

    // ── showWindow ────────────────────────────────────────────────────────────
    if (command == "showWindow" || command == "show") {
        GtkWidget* w = get_win();
        if (w) { gtk_widget_show_all(w); gtk_window_present(GTK_WINDOW(w)); }
        return;
    }

    // ── focus ────────────────────────────────────────────────────────────────
    if (command == "focus") {
        GtkWidget* w = get_win();
        if (w) gtk_window_present(GTK_WINDOW(w));
        return;
    }

    // ── isVisible ────────────────────────────────────────────────────────────
    if (command == "isVisible") {
        GtkWidget* w = get_win();
        bool vis = w && gtk_widget_is_visible(w);
        send_reply(window_id, get_last_arg(args, "isVisible-reply-" + to_string(window_id)), "isVisible", vis ? "true" : "false");
        return;
    }

    // ── isFocused ────────────────────────────────────────────────────────────
    if (command == "isFocused") {
        GtkWidget* w = get_win();
        bool focused = w && gtk_window_is_active(GTK_WINDOW(w));
        send_reply(window_id, get_last_arg(args, "isFocused-reply-" + to_string(window_id)), "isFocused", focused ? "true" : "false");
        return;
    }

    // ── getFocusedWindowId ───────────────────────────────────────────────────
    if (command == "getFocusedWindowId") {
        int focused_id = -1;
        for (auto& kv : windowMap)
            if (gtk_window_is_active(GTK_WINDOW(kv.second.window))) { focused_id = kv.first; break; }
        send_reply(window_id, get_last_arg(args, "getFocusedWindowId-reply-" + to_string(window_id)), "focusedWindowId", to_string(focused_id));
        return;
    }

    // ── isFullscreen ─────────────────────────────────────────────────────────
    if (command == "isFullscreen") {
        GtkWidget* w = get_win();
        GdkWindow* gdk_win = w ? gtk_widget_get_window(w) : nullptr;
        bool fs = gdk_win &&
            (gdk_window_get_state(gdk_win) & GDK_WINDOW_STATE_FULLSCREEN);
        send_reply(window_id, get_last_arg(args, "isFullscreen-reply-" + to_string(window_id)), "isFullscreen", fs ? "true" : "false");
        return;
    }

    // ── fullscreen ───────────────────────────────────────────────────────────
    if (command == "fullscreen" || command == "toggleFullscreen") {
        GtkWidget* w = get_win();
        if (!w) return;
        GdkWindow* gdk_win = gtk_widget_get_window(w);
        bool fs = gdk_win && (gdk_window_get_state(gdk_win) & GDK_WINDOW_STATE_FULLSCREEN);
        if (command == "toggleFullscreen" ? true : !fs) {
            if (fs) gtk_window_unfullscreen(GTK_WINDOW(w));
            else    gtk_window_fullscreen(GTK_WINDOW(w));
        } else {
            gtk_window_fullscreen(GTK_WINDOW(w));
        }
        return;
    }

    // ── exitFullscreen ───────────────────────────────────────────────────────
    if (command == "exitFullscreen") {
        GtkWidget* w = get_win();
        if (w) gtk_window_unfullscreen(GTK_WINDOW(w));
        return;
    }

    // ── resizeWindow / resize ────────────────────────────────────────────────
    if (command == "resizeWindow" || command == "resize") {
        GtkWidget* w = get_win();
        if (w && args.size() >= 2)
            gtk_window_resize(GTK_WINDOW(w), stoi(args[0]), stoi(args[1]));
        return;
    }

    // ── setBounds ────────────────────────────────────────────────────────────
    if (command == "setBounds") {
        GtkWidget* w = get_win();
        if (w && args.size() >= 4) {
            gtk_window_move(GTK_WINDOW(w), stoi(args[0]), stoi(args[1]));
            gtk_window_resize(GTK_WINDOW(w), stoi(args[2]), stoi(args[3]));
        }
        return;
    }

    // ── getBounds ────────────────────────────────────────────────────────────
    if (command == "getBounds") {
        GtkWidget* w = get_win();
        int x = 0, y = 0, width = 0, height = 0;
        if (w) { gtk_window_get_position(GTK_WINDOW(w), &x, &y); gtk_window_get_size(GTK_WINDOW(w), &width, &height); }
        JsonBuilder* b = json_builder_new();
        json_builder_begin_object(b);
        json_builder_set_member_name(b, "x");      json_builder_add_string_value(b, to_string(x).c_str());
        json_builder_set_member_name(b, "y");      json_builder_add_string_value(b, to_string(y).c_str());
        json_builder_set_member_name(b, "width");  json_builder_add_string_value(b, to_string(width).c_str());
        json_builder_set_member_name(b, "height"); json_builder_add_string_value(b, to_string(height).c_str());
        json_builder_end_object(b);
        send_ipc(window_id, get_last_arg(args, "getBounds-reply-" + to_string(window_id)), b);
        return;
    }

    // ── setResizable ─────────────────────────────────────────────────────────
    if (command == "setResizable") {
        GtkWidget* w = get_win();
        if (w && !args.empty()) gtk_window_set_resizable(GTK_WINDOW(w), args[0] == "true");
        return;
    }

    // ── setAlwaysOnTop ────────────────────────────────────────────────────────
    if (command == "setAlwaysOnTop") {
        GtkWidget* w = get_win();
        if (w && !args.empty()) gtk_window_set_keep_above(GTK_WINDOW(w), args[0] == "true");
        return;
    }

    // ── reload ───────────────────────────────────────────────────────────────
    if (command == "reload") {
        WebKitWebView* wv = get_wv();
        if (wv) webkit_web_view_reload(wv);
        return;
    }

    // ── forward / back ───────────────────────────────────────────────────────
    if (command == "forward") {
        WebKitWebView* wv = get_wv();
        if (wv) webkit_web_view_go_forward(wv);
        return;
    }
    if (command == "back") {
        WebKitWebView* wv = get_wv();
        if (wv) webkit_web_view_go_back(wv);
        return;
    }

    // ── canGoBack / canGoForward ──────────────────────────────────────────────
    if (command == "canGoBack") {
        WebKitWebView* wv = get_wv();
        bool can = wv && webkit_web_view_can_go_back(wv);
        send_reply(window_id, get_last_arg(args, "canGoBack-reply-" + to_string(window_id)), "canGoBack", can ? "true" : "false");
        return;
    }
    if (command == "canGoForward") {
        WebKitWebView* wv = get_wv();
        bool can = wv && webkit_web_view_can_go_forward(wv);
        send_reply(window_id, get_last_arg(args, "canGoForward-reply-" + to_string(window_id)), "canGoForward", can ? "true" : "false");
        return;
    }

    // ── setUserAgent ─────────────────────────────────────────────────────────
    if (command == "setUserAgent") {
        WebKitWebView* wv = get_wv();
        if (wv && !args.empty()) {
            WebKitSettings* s = webkit_web_view_get_settings(wv);
            webkit_settings_set_user_agent(s, args[0].c_str());
        }
        return;
    }

    // ── evaluateJS ───────────────────────────────────────────────────────────
    if (command == "evaluateJS") {
        if (args.empty()) return;
        const string& script = args[0];
        const string reply_ch = get_last_arg(args, "evaluateJS-reply-" + to_string(window_id));
        WebKitWebView* wv = get_wv();
        if (!wv) return;
        // capture reply_ch by copy
        struct Ctx { int wid; string reply; };
        auto* ctx = new Ctx{ window_id, reply_ch };
#if WEBKIT_CHECK_VERSION(2, 40, 0)
        webkit_web_view_evaluate_javascript(wv, script.c_str(), -1, nullptr, nullptr, nullptr,
            [](GObject* src, GAsyncResult* res, gpointer data) {
                auto* ctx = static_cast<Ctx*>(data);
                GError* err = nullptr;
                JSCValue* val = webkit_web_view_evaluate_javascript_finish(WEBKIT_WEB_VIEW(src), res, &err);
                string result_str = "null";
                if (err) { g_error_free(err); }
                else if (val) {
                    gchar* str = jsc_value_to_json(val, 0);
                    if (str) { result_str = str; g_free(str); }
                    g_object_unref(val);
                }
                send_reply(ctx->wid, ctx->reply, "result", result_str);
                delete ctx;
            }, ctx);
#else
        webkit_web_view_run_javascript(wv, script.c_str(), nullptr,
            [](GObject* src, GAsyncResult* res, gpointer data) {
                auto* ctx = static_cast<Ctx*>(data);
                GError* err = nullptr;
                WebKitJavascriptResult* js_result =
                    webkit_web_view_run_javascript_finish(WEBKIT_WEB_VIEW(src), res, &err);
                string result_str = "null";
                if (err) { g_error_free(err); }
                else if (js_result) {
                    JSCValue* val = webkit_javascript_result_get_js_value(js_result);
                    if (val) {
                        gchar* str = jsc_value_to_json(val, 0);
                        if (str) { result_str = str; g_free(str); }
                    }
                    webkit_javascript_result_unref(js_result);
                }
                send_reply(ctx->wid, ctx->reply, "result", result_str);
                delete ctx;
            }, ctx);
#endif
        return;
    }

    // ── emitToRenderer ────────────────────────────────────────────────────────
    if (command == "emitToRenderer") {
        if (args.size() < 2) return;
        string escaped = js_escape(args[1]);
        string script = "window.ipc._emit(`" + js_escape(args[0]) + "`, JSON.parse(`" + escaped + "`));";
        evaluate_js(window_id, script);
        return;
    }

    // ── addUserScript ────────────────────────────────────────────────────────
    if (command == "addUserScript") {
        WebKitWebView* wv = get_wv();
        if (!wv || args.empty()) return;
        WebKitUserContentManager* ucm = webkit_web_view_get_user_content_manager(wv);
        WebKitUserScript* script = webkit_user_script_new(
            args[0].c_str(),
            WEBKIT_USER_CONTENT_INJECT_ALL_FRAMES,
            WEBKIT_USER_SCRIPT_INJECT_AT_DOCUMENT_START,
            nullptr, nullptr);
        webkit_user_content_manager_add_script(ucm, script);
        webkit_user_script_unref(script);
        return;
    }

    // ── openDevTools ─────────────────────────────────────────────────────────
    if (command == "openDevTools") {
        WebKitWebView* wv = get_wv();
        if (!wv) return;
        WebKitSettings* s = webkit_web_view_get_settings(wv);
        webkit_settings_set_enable_developer_extras(s, TRUE);
        WebKitWebInspector* inspector = webkit_web_view_get_inspector(wv);
        webkit_web_inspector_show(inspector);
        return;
    }

    // ── alert ────────────────────────────────────────────────────────────────
    if (command == "alert") {
        GtkWidget* w = get_win();
        if (!w || args.empty()) return;
        GtkWidget* dialog = gtk_message_dialog_new(GTK_WINDOW(w),
            GTK_DIALOG_MODAL, GTK_MESSAGE_INFO, GTK_BUTTONS_OK, "%s", args[0].c_str());
        g_signal_connect(dialog, "response", G_CALLBACK(+[](GtkDialog* dlg, gint response, gpointer user_data) {
            gtk_widget_destroy(GTK_WIDGET(dlg));
        }), nullptr);
        gtk_widget_show_all(dialog);
        return;
    }

    // ── confirm ──────────────────────────────────────────────────────────────
    if (command == "confirm") {
        GtkWidget* w = get_win();
        if (!w || args.empty()) return;
        GtkWidget* dialog = gtk_message_dialog_new(GTK_WINDOW(w),
            GTK_DIALOG_MODAL, GTK_MESSAGE_QUESTION, GTK_BUTTONS_OK_CANCEL, "%s", args[0].c_str());

        struct ConfirmData { int wid; string ch; };
        auto* d = new ConfirmData{ window_id, get_last_arg(args, "confirm-reply-" + to_string(window_id)) };

        g_signal_connect(dialog, "response", G_CALLBACK(+[](GtkDialog* dlg, gint response, gpointer user_data) {
            auto* data = static_cast<ConfirmData*>(user_data);
            bool confirmed = (response == GTK_RESPONSE_OK);
            send_reply(data->wid, data->ch, "confirmed", confirmed ? "true" : "false");
            delete data;
            gtk_widget_destroy(GTK_WIDGET(dlg));
        }), d);
        gtk_widget_show_all(dialog);
        return;
    }

    // ── prompt ───────────────────────────────────────────────────────────────
    if (command == "prompt") {
        GtkWidget* w = get_win();
        if (!w || args.empty()) return;
        GtkWidget* dialog = gtk_dialog_new_with_buttons(
            "Input", GTK_WINDOW(w),
            GTK_DIALOG_MODAL,
            "_OK", GTK_RESPONSE_OK,
            "_Cancel", GTK_RESPONSE_CANCEL,
            nullptr);
        GtkWidget* content = gtk_dialog_get_content_area(GTK_DIALOG(dialog));
        GtkWidget* label = gtk_label_new(args[0].c_str());
        GtkWidget* entry = gtk_entry_new();
        if (args.size() > 1) gtk_entry_set_text(GTK_ENTRY(entry), args[1].c_str());
        gtk_box_pack_start(GTK_BOX(content), label, FALSE, FALSE, 4);
        gtk_box_pack_start(GTK_BOX(content), entry, FALSE, FALSE, 4);

        struct PromptData { int wid; string ch; GtkWidget* entry; };
        auto* d = new PromptData{ window_id, get_last_arg(args, "prompt-reply-" + to_string(window_id)), entry };

        g_signal_connect(dialog, "response", G_CALLBACK(+[](GtkDialog* dlg, gint response, gpointer user_data) {
            auto* data = static_cast<PromptData*>(user_data);
            string input = (response == GTK_RESPONSE_OK)
                ? gtk_entry_get_text(GTK_ENTRY(data->entry)) : "";
            send_reply(data->wid, data->ch, "input", input);
            delete data;
            gtk_widget_destroy(GTK_WIDGET(dlg));
        }), d);
        gtk_widget_show_all(dialog);
        return;
    }

    // ── showFileOpenDialog ───────────────────────────────────────────────────
    if (command == "showFileOpenDialog") {
        GtkWidget* w = get_win();
        GtkWidget* chooser = gtk_file_chooser_dialog_new("Open File",
            w ? GTK_WINDOW(w) : nullptr,
            GTK_FILE_CHOOSER_ACTION_OPEN,
            "_Cancel", GTK_RESPONSE_CANCEL,
            "_Open",   GTK_RESPONSE_ACCEPT,
            nullptr);

        struct FileOpenData { int wid; string ch; };
        auto* d = new FileOpenData{ window_id, get_last_arg(args, "showFileOpenDialog-reply-" + to_string(window_id)) };

        g_signal_connect(chooser, "response", G_CALLBACK(+[](GtkDialog* dlg, gint response, gpointer user_data) {
            auto* data = static_cast<FileOpenData*>(user_data);
            string file_path = "";
            if (response == GTK_RESPONSE_ACCEPT) {
                gchar* filename = gtk_file_chooser_get_filename(GTK_FILE_CHOOSER(dlg));
                if (filename) { file_path = filename; g_free(filename); }
            }
            send_reply(data->wid, data->ch, "filePath", file_path);
            delete data;
            gtk_widget_destroy(GTK_WIDGET(dlg));
        }), d);
        gtk_widget_show_all(chooser);
        return;
    }

    // ── readFromClipboard ────────────────────────────────────────────────────
    if (command == "readFromClipboard") {
        GtkClipboard* cb = gtk_clipboard_get(GDK_SELECTION_CLIPBOARD);
        gchar* text = gtk_clipboard_wait_for_text(cb);
        string result = text ? text : "";
        if (text) g_free(text);
        send_reply(window_id, get_last_arg(args, "readFromClipboard-reply-" + to_string(window_id)), "text", result);
        return;
    }

    // ── writeToClipboard ─────────────────────────────────────────────────────
    if (command == "writeToClipboard") {
        if (args.empty()) return;
        GtkClipboard* cb = gtk_clipboard_get(GDK_SELECTION_CLIPBOARD);
        gtk_clipboard_set_text(cb, args[0].c_str(), -1);
        gtk_clipboard_store(cb);
        return;
    }

    // ── isDarkMode ───────────────────────────────────────────────────────────
    if (command == "isDarkMode") {
        GtkSettings* settings = gtk_settings_get_default();
        gchar* theme_name = nullptr;
        g_object_get(settings, "gtk-theme-name", &theme_name, nullptr);
        bool dark = theme_name && g_str_has_suffix(g_ascii_strdown(theme_name, -1), "dark");
        if (theme_name) g_free(theme_name);
        // Also check prefer-dark-theme
        gboolean prefer_dark = FALSE;
        g_object_get(settings, "gtk-application-prefer-dark-theme", &prefer_dark, nullptr);
        send_reply(window_id, get_last_arg(args, "isDarkMode-reply-" + to_string(window_id)), "isDarkMode", (dark || prefer_dark) ? "true" : "false");
        return;
    }

    // ── showNotification ─────────────────────────────────────────────────────
    if (command == "showNotification") {
        if (args.empty()) return;
        notify_init("Positron");
        NotifyNotification* notif = notify_notification_new(
            args[0].c_str(),
            args.size() > 1 ? args[1].c_str() : nullptr,
            nullptr);
        notify_notification_show(notif, nullptr);
        g_object_unref(notif);
        return;
    }

    // ── capturePage ──────────────────────────────────────────────────────────
    if (command == "capturePage") {
        WebKitWebView* wv = get_wv();
        if (!wv) return;
        webkit_web_view_get_snapshot(wv,
            WEBKIT_SNAPSHOT_REGION_VISIBLE,
            WEBKIT_SNAPSHOT_OPTIONS_NONE,
            nullptr, on_snapshot_ready, GINT_TO_POINTER(window_id));
        return;
    }

    // ── setContextMenu ───────────────────────────────────────────────────────
    if (command == "setContextMenu") {
        WebKitWebView* wv = get_wv();
        if (!wv || args.empty()) return;
        JsonParser* parser = json_parser_new();
        if (json_parser_load_from_data(parser, args[0].c_str(), -1, nullptr)) {
            JsonNode* root = json_parser_get_root(parser);
            if (JSON_NODE_HOLDS_ARRAY(root)) {
                GtkWidget* menu = build_context_menu(json_node_get_array(root), window_id);
                // Store reference on webview for right-click (handled via policy)
                g_object_set_data_full(G_OBJECT(wv), "context-menu", menu, (GDestroyNotify)gtk_widget_destroy);
            }
        }
        g_object_unref(parser);
        return;
    }

    // ── setCloseable / setMinimizible ────────────────────────────────────────
    // Note: GTK doesn't allow dynamically toggling decorations at runtime easily.
    // These are no-ops on Linux with a note.
    if (command == "setCloseable" || command == "setMinimizible") {
        cerr << "[Linux Core] " << command << " is not supported at runtime on Linux/GTK." << endl;
        return;
    }

    // ── blockPowerSave / unblockPowerSave ────────────────────────────────────
    // Handled via dbus / systemd inhibit — stub for now
    if (command == "blockPowerSave" || command == "unblockPowerSave") {
        cerr << "[Linux Core] " << command << " is a no-op on Linux (requires systemd-inhibit integration)." << endl;
        return;
    }

    // ── print ────────────────────────────────────────────────────────────────
    if (command == "print") {
        WebKitWebView* wv = get_wv();
        if (!wv) return;
        WebKitPrintOperation* op = webkit_print_operation_new(wv);
        webkit_print_operation_run_dialog(op, nullptr);
        g_object_unref(op);
        return;
    }

    // ── fallthrough: extension registry ─────────────────────────────────────
    auto registry = getExtensionRegistry();
    if (registry.count(command)) {
        registry[command](window_id, args);
    } else {
        cerr << "[Linux Core] Unknown command: " << command << endl;
    }
}

// ─── WebSocket message handler ───────────────────────────────────────────────

void on_ws_message(SoupWebsocketConnection* conn, gint type, GBytes* message, gpointer) {
    gsize size;
    const gchar* ptr = (const gchar*)g_bytes_get_data(message, &size);

    JsonParser* parser = json_parser_new();
    if (!json_parser_load_from_data(parser, ptr, (gssize)size, nullptr)) {
        g_object_unref(parser);
        return;
    }

    JsonNode* root = json_parser_get_root(parser);
    if (!root || !JSON_NODE_HOLDS_OBJECT(root)) {
        g_object_unref(parser);
        return;
    }

    JsonObject* obj = json_node_get_object(root);
    int window_id   = json_object_has_member(obj, "windowId") ? (int)json_object_get_int_member(obj, "windowId") : -1;
    string command  = json_object_has_member(obj, "command") ? json_object_get_string_member(obj, "command") : "";
    
    vector<string> args;
    if (json_object_has_member(obj, "args")) {
        JsonArray* arr = json_object_get_array_member(obj, "args");
        if (arr) {
            for (guint i = 0; i < json_array_get_length(arr); i++)
                args.push_back(json_array_get_string_element(arr, i));
        }
    }

    handle_command(window_id, command, args);
    g_object_unref(parser);
}

void on_ws_closed(SoupWebsocketConnection*, gpointer) {
    cout << "[Linux Core] IPC connection closed. Terminating." << endl;
    gtk_main_quit();
}

void on_ws_connected(GObject* source, GAsyncResult* res, gpointer) {
    GError* error = nullptr;
    ws_conn = soup_session_websocket_connect_finish(SOUP_SESSION(source), res, &error);
    if (error) {
        cerr << "[Linux Core] Failed to connect to IPC: " << error->message << endl;
        g_error_free(error);
        gtk_main_quit();
        return;
    }
    g_signal_connect(ws_conn, "message", G_CALLBACK(on_ws_message), nullptr);
    g_signal_connect(ws_conn, "closed",  G_CALLBACK(on_ws_closed),  nullptr);
}

// ─── Port / UUID helpers ──────────────────────────────────────────────────────

static int find_open_port() {
    int sock = socket(AF_INET, SOCK_STREAM, 0);
    if (sock < 0) return 9000;
    struct sockaddr_in addr{};
    addr.sin_family = AF_INET;
    addr.sin_addr.s_addr = INADDR_ANY;
    addr.sin_port = 0;
    if (bind(sock, (struct sockaddr*)&addr, sizeof(addr)) < 0) { close(sock); return 9000; }
    socklen_t len = sizeof(addr);
    getsockname(sock, (struct sockaddr*)&addr, &len);
    int port = ntohs(addr.sin_port);
    close(sock);
    return port;
}

static string generate_uuid() {
    ifstream f("/proc/sys/kernel/random/uuid");
    if (f.good()) { string uuid; f >> uuid; return uuid; }
    unsigned char buf[16];
    ifstream urandom("/dev/urandom", ios::binary);
    urandom.read((char*)buf, 16);
    buf[6] = (buf[6] & 0x0f) | 0x40;
    buf[8] = (buf[8] & 0x3f) | 0x80;
    char out[37];
    snprintf(out, sizeof(out),
        "%02x%02x%02x%02x-%02x%02x-%02x%02x-%02x%02x-%02x%02x%02x%02x%02x%02x",
        buf[0],buf[1],buf[2],buf[3],buf[4],buf[5],buf[6],buf[7],
        buf[8],buf[9],buf[10],buf[11],buf[12],buf[13],buf[14],buf[15]);
    return string(out);
}

// ─── Entry point ─────────────────────────────────────────────────────────────

static GPid node_pid = 0;

static void on_node_exit(GPid pid, gint, gpointer) {
    cerr << "[Linux Core] Node.js backend exited. Terminating." << endl;
    gtk_main_quit();
    g_spawn_close_pid(pid);
}

int main(int argc, char* argv[]) {
    gtk_init(&argc, &argv);

    // Locate executable directory
    char self_path[PATH_MAX];
    ssize_t self_len = readlink("/proc/self/exe", self_path, sizeof(self_path) - 1);
    string exe_dir = "";
    if (self_len >= 0) {
        self_path[self_len] = '\0';
        exe_dir = string(self_path);
        exe_dir = exe_dir.substr(0, exe_dir.rfind('/'));

        // Attempt to load application icon
        string icon_path = exe_dir + "/resources/icon.png";
        if (access(icon_path.c_str(), F_OK) == -1) {
            icon_path = exe_dir + "/icon.png";
        }
        if (access(icon_path.c_str(), F_OK) != -1) {
            gtk_window_set_default_icon_from_file(icon_path.c_str(), nullptr);
        }
    }

    const char* port_env  = getenv("POSITRON_IPC_PORT");
    const char* token_env = getenv("POSITRON_AUTH_TOKEN");

    string ipc_port, ipc_token;

    if (port_env && token_env) {
        // ── Dev mode: Node.js spawned us and passed creds via env ─────────────
        ipc_port  = port_env;
        ipc_token = token_env;
    } else {
        // ── Packaged mode: we are the entry point ─────────────────────────────
        ipc_port  = to_string(find_open_port());
        ipc_token = generate_uuid();

        if (exe_dir.empty()) { cerr << "[Linux Core] Failed to resolve executable path." << endl; return 1; }
        string resources_dir = exe_dir + "/resources";

        // Find *-backend binary
        string backend_bin;
        GDir* dir = g_dir_open(resources_dir.c_str(), 0, nullptr);
        if (dir) {
            const gchar* name;
            while ((name = g_dir_read_name(dir)) != nullptr) {
                string n = name;
                if (n.size() > 8 && n.substr(n.size() - 8) == "-backend") {
                    backend_bin = resources_dir + "/" + n;
                    break;
                }
            }
            g_dir_close(dir);
        }

        if (backend_bin.empty()) {
            cerr << "[Linux Core] Could not find *-backend binary in " << resources_dir << endl;
            return 1;
        }

        // Build environment
        vector<string> envp_storage;
        for (int i = 0; environ[i]; i++) {
            string e = environ[i];
            if (e.rfind("POSITRON_IPC_PORT=", 0) == 0) continue;
            if (e.rfind("POSITRON_AUTH_TOKEN=", 0) == 0) continue;
            if (e.rfind("POSITRON_PACKAGED=", 0) == 0) continue;
            envp_storage.push_back(e);
        }
        envp_storage.push_back("POSITRON_IPC_PORT=" + ipc_port);
        envp_storage.push_back("POSITRON_AUTH_TOKEN=" + ipc_token);
        envp_storage.push_back("POSITRON_PACKAGED=true");

        vector<const gchar*> envp;
        for (auto& s : envp_storage) envp.push_back(s.c_str());
        envp.push_back(nullptr);

        string cmd = "\"" + backend_bin + "\"";
        const gchar* argv_spawn[] = { "/bin/sh", "-c", cmd.c_str(), nullptr };
        GSpawnFlags flags = (GSpawnFlags)(G_SPAWN_DO_NOT_REAP_CHILD);
        GError* spawn_err = nullptr;
        gboolean ok = g_spawn_async(
            resources_dir.c_str(),
            (gchar**)argv_spawn,
            (gchar**)envp.data(),
            flags,
            nullptr, nullptr,
            &node_pid,
            &spawn_err);

        if (!ok) {
            cerr << "[Linux Core] Failed to spawn backend: "
                 << (spawn_err ? spawn_err->message : "unknown") << endl;
            if (spawn_err) g_error_free(spawn_err);
            return 1;
        }

        g_child_watch_add(node_pid, on_node_exit, nullptr);
        cout << "[Linux Core] Spawned backend (pid " << node_pid << "). Waiting for IPC..." << endl;
        g_usleep(800000); // 0.8 s — give Node time to bind the WebSocket
    }

    auth_token = ipc_token;
    string url = "ws://127.0.0.1:" + ipc_port;

    // Build WebSocket upgrade request with auth header
    SoupSession* session = soup_session_new();
    SoupMessage* msg = soup_message_new("GET", url.c_str());

#if defined(SOUP_VERSION_2_4) && !defined(SOUP_VERSION_3_0)
    soup_message_headers_append(msg->request_headers,
        "x-positron-auth-token", auth_token.c_str());
#else
    // libsoup 3.x
    SoupMessageHeaders* headers = soup_message_get_request_headers(msg);
    soup_message_headers_append(headers, "x-positron-auth-token", auth_token.c_str());
#endif

    soup_session_websocket_connect_async(session, msg, nullptr, nullptr,
        G_PRIORITY_DEFAULT, nullptr, on_ws_connected, nullptr);

    signal(SIGTERM, [](int) { if (node_pid) kill(node_pid, SIGTERM); gtk_main_quit(); });
    signal(SIGINT,  [](int) { if (node_pid) kill(node_pid, SIGTERM); gtk_main_quit(); });

    gtk_main();

    if (node_pid) kill(node_pid, SIGTERM);
    if (ws_conn) g_object_unref(ws_conn);
    g_object_unref(session);
    return 0;
}
