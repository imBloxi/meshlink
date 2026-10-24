package dev.imbloxi.nodelink;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.Uri;
import android.os.Bundle;
import android.provider.Settings;
import android.util.Base64;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.view.WindowManager;
import androidx.webkit.WebViewAssetLoader;
import androidx.webkit.WebViewClientCompat;
import java.io.ByteArrayInputStream;
import java.util.Arrays;
import java.util.Collections;
import java.util.concurrent.TimeUnit;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;
import okio.ByteString;
import org.json.JSONObject;

public final class MainActivity extends Activity {
    private static final String ORIGIN = "appassets.androidplatform.net";
    private WebView web;
    private Bridge bridge;
    private boolean destroyed;

    @Override public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_SECURE);
        getWindow().setStatusBarColor(Color.rgb(11, 15, 20));
        getWindow().setNavigationBarColor(Color.rgb(16, 22, 29));
        if (android.os.Build.VERSION.SDK_INT >= 30) getWindow().setDecorFitsSystemWindows(false);
        web = new WebView(this);
        web.setBackgroundColor(Color.rgb(11, 15, 20));
        // Fit system bars and the keyboard rather than placing tappable content underneath them.
        web.setOnApplyWindowInsetsListener((view, insets) -> {
            if (android.os.Build.VERSION.SDK_INT >= 30) {
                android.graphics.Insets bars = insets.getInsets(android.view.WindowInsets.Type.systemBars() | android.view.WindowInsets.Type.displayCutout());
                android.graphics.Insets keyboard = insets.getInsets(android.view.WindowInsets.Type.ime());
                view.setPadding(bars.left, bars.top, bars.right, Math.max(bars.bottom, keyboard.bottom));
            }
            return insets;
        });
        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(false);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setCacheMode(WebSettings.LOAD_NO_CACHE);
        CookieManager.getInstance().setAcceptCookie(false);
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG);
        WebViewAssetLoader assets = new WebViewAssetLoader.Builder()
                .addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(this)).build();
        web.setWebViewClient(new WebViewClientCompat() {
            @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if ("https".equals(uri.getScheme()) && ORIGIN.equals(uri.getHost()) && uri.getPath() != null && uri.getPath().startsWith("/assets/public/")) {
                    WebResourceResponse response = assets.shouldInterceptRequest(uri);
                    if (response != null) {
                        response.setResponseHeaders(Collections.singletonMap("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"));
                        return response;
                    }
                }
                return new WebResourceResponse("text/plain", "UTF-8", 403, "Blocked", Collections.emptyMap(), new ByteArrayInputStream(new byte[0]));
            }
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                // All app navigation is internal React state. No remote page may inherit the native bridge.
                return true;
            }
        });
        bridge = new Bridge();
        web.addJavascriptInterface(bridge, "NodeLinkAndroid");
        setContentView(web);
        web.loadUrl("https://" + ORIGIN + "/assets/public/index.html");
        if (android.os.Build.VERSION.SDK_INT >= 33) {
            getOnBackInvokedDispatcher().registerOnBackInvokedCallback(android.window.OnBackInvokedDispatcher.PRIORITY_DEFAULT,
                    () -> web.evaluateJavascript("window.dispatchEvent(new Event('nodelink-back'))", null));
        }
    }

    @Override public void onBackPressed() {
        web.evaluateJavascript("window.dispatchEvent(new Event('nodelink-back'))", null);
    }
    @Override protected void onStop() {
        super.onStop();
        bridge.stopWithNotice();
    }
    @Override protected void onDestroy() {
        destroyed = true;
        bridge.closeNode();
        web.removeJavascriptInterface("NodeLinkAndroid");
        web.destroy();
        super.onDestroy();
    }
    private void event(int session, String type, String data) {
        runOnUiThread(() -> {
            if (destroyed) return;
            String detail = "{session:" + session + ",type:" + JSONObject.quote(type) + ",data:" + JSONObject.quote(data) + "}";
            web.evaluateJavascript("window.dispatchEvent(new CustomEvent('nodelink',{detail:" + detail + "}))", null);
        });
    }

    public final class Bridge {
        private final SecureVault vault = new SecureVault(MainActivity.this);
        private WebSocket socket;
        private OkHttpClient client;
        private int activeSession;
        private String reply(String value) {
            return "{\"ok\":true,\"value\":" + (value == null ? "null" : JSONObject.quote(value)) + "}";
        }
        private String failure(Exception error) {
            return "{\"ok\":false,\"error\":" + JSONObject.quote("Encrypted storage is unavailable. " + error.getClass().getSimpleName()) + "}";
        }
        @JavascriptInterface public String loadVault() {
            try { return reply(vault.load()); } catch (Exception error) { return failure(error); }
        }
        @JavascriptInterface public String saveVault(String value) {
            try { vault.save(value); return reply(null); } catch (Exception error) { return failure(error); }
        }
        @JavascriptInterface public String wipeVault() {
            try { vault.wipe(); return reply(null); } catch (Exception error) { return failure(error); }
        }
        @JavascriptInterface public void openWifiSettings() {
            runOnUiThread(() -> startActivity(new Intent(Settings.ACTION_WIFI_SETTINGS)));
        }
        @JavascriptInterface public void backgroundApp() {
            runOnUiThread(() -> moveTaskToBack(true));
        }
        @JavascriptInterface public synchronized void openNode(String input, int session) {
            closeNode();
            activeSession = session;
            try {
                String host = NodeAddress.validate(input);
                ConnectivityManager manager = (ConnectivityManager) getSystemService(CONNECTIVITY_SERVICE);
                Network wifi = null;
                for (Network network : manager.getAllNetworks()) {
                    NetworkCapabilities capabilities = manager.getNetworkCapabilities(network);
                    if (capabilities != null && capabilities.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)
                            && capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_VPN)) { wifi = network; break; }
                }
                if (wifi == null) throw new IllegalStateException("Join the node’s Wi-Fi hotspot first, then return to NodeLink.");
                Network route = wifi;
                client = new OkHttpClient.Builder().socketFactory(route.getSocketFactory())
                        .dns(hostname -> Arrays.asList(route.getAllByName(hostname)))
                        .proxy(java.net.Proxy.NO_PROXY).followRedirects(false).followSslRedirects(false)
                        .connectTimeout(5, TimeUnit.SECONDS).readTimeout(0, TimeUnit.MILLISECONDS)
                        .pingInterval(20, TimeUnit.SECONDS).build();
                socket = client.newWebSocket(new Request.Builder().url("ws://" + host + ":81/").build(), new WebSocketListener() {
                    @Override public void onMessage(WebSocket ws, ByteString bytes) {
                        if (bytes.size() > 1024) { ws.cancel(); event(session, "closed", "Node sent an oversized frame."); return; }
                        event(session, "frame", bytes.base64());
                    }
                    @Override public void onMessage(WebSocket ws, String text) {
                        ws.cancel(); event(session, "closed", "Node sent an invalid text frame.");
                    }
                    @Override public void onClosing(WebSocket ws, int code, String reason) {
                        ws.close(code, null); event(session, "closed", "The node closed the Wi-Fi connection.");
                    }
                    @Override public void onFailure(WebSocket ws, Throwable error, Response response) {
                        event(session, "closed", "Could not reach the node. Check its Wi-Fi hotspot and IP address.");
                    }
                });
            } catch (Exception error) {
                event(session, "closed", error.getMessage() == null ? "Could not connect to the node." : error.getMessage());
            }
        }
        @JavascriptInterface public synchronized boolean sendFrame(String encoded, int session) {
            if (session != activeSession || socket == null || encoded == null || encoded.length() > 1400) return false;
            try {
                byte[] bytes = Base64.decode(encoded, Base64.NO_WRAP);
                if (bytes.length == 0 || bytes.length > 1024) return false;
                // INFO_REQ, AUTH and SEND only: no USB admin commands in this bridge.
                int type = bytes[0] & 0xff;
                if (type != 0x10 && type != 0x11 && type != 0x14) return false;
                return socket.send(ByteString.of(bytes));
            } catch (IllegalArgumentException error) { return false; }
        }
        @JavascriptInterface public synchronized void closeNode() {
            activeSession = 0;
            if (socket != null) socket.cancel();
            socket = null;
            if (client != null) {
                client.dispatcher().executorService().shutdown();
                client.connectionPool().evictAll();
            }
            client = null;
        }
        synchronized void stopWithNotice() {
            int session = activeSession;
            closeNode();
            if (session != 0) event(session, "closed", "Connection paused while NodeLink was in the background. Reconnect to receive messages.");
        }
    }
}
