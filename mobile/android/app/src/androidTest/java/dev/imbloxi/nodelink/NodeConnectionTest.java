package dev.imbloxi.nodelink;

import android.content.Context;
import android.net.ConnectivityManager;
import android.net.LinkAddress;
import android.net.LinkProperties;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.os.SystemClock;
import android.util.Base64;
import android.webkit.WebView;
import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import androidx.test.espresso.web.webdriver.Locator;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.After;
import org.junit.Test;
import org.junit.runner.RunWith;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.security.SecureRandom;
import java.util.UUID;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;
import okhttp3.mockwebserver.MockResponse;
import okhttp3.mockwebserver.MockWebServer;
import okio.ByteString;
import static androidx.test.espresso.Espresso.onView;
import static androidx.test.espresso.action.ViewActions.*;
import static androidx.test.espresso.matcher.ViewMatchers.isAssignableFrom;
import static androidx.test.espresso.web.sugar.Web.onWebView;
import static androidx.test.espresso.web.webdriver.DriverAtoms.*;
import static androidx.test.espresso.web.assertion.WebViewAssertions.webMatches;
import static org.hamcrest.Matchers.containsString;
import static org.junit.Assert.*;
import static org.junit.Assume.assumeTrue;

/** Real packaged UI -> native Wi-Fi socket -> local WebSocket node fixture.
 * This verifies the Android transport, not physical ESP8266 radio behavior. */
@RunWith(AndroidJUnit4.class)
public class NodeConnectionTest {
    private final String name = "Socket-" + UUID.randomUUID().toString().substring(0, 8);
    private ActivityScenario<MainActivity> scenario;
    private SecureVault vault;
    private MockWebServer server;
    private volatile WebSocket node;

    @After public void cleanupOwnAccount() throws Exception {
        try {
            if (scenario != null) scenario.close();
            // MockWebServer's upgraded server socket has no client Call to
            // cancel. Close its WebSocket and let the server own socket cleanup.
            if (node != null) node.close(1000, "Fixture complete");
        } finally {
            try { if (server != null) server.shutdown(); }
            finally {
                if (vault != null) {
                    String saved = vault.load();
                    if (saved != null && name.equals(new JSONObject(saved).optString("name"))) vault.wipe();
                }
            }
        }
    }

    private void waitForText(String selector, String text) {
        long deadline = SystemClock.uptimeMillis() + 15000;
        Throwable last = null;
        while (SystemClock.uptimeMillis() < deadline) {
            try {
                onWebView().withElement(findElement(Locator.CSS_SELECTOR, selector))
                        .check(webMatches(getText(), containsString(text)));
                return;
            } catch (RuntimeException | AssertionError error) { last = error; SystemClock.sleep(150); }
        }
        throw new AssertionError("Packaged app did not show " + selector + ": " + text, last);
    }

    private InetAddress wifiAddress(Context context) {
        ConnectivityManager manager = (ConnectivityManager) context.getSystemService(Context.CONNECTIVITY_SERVICE);
        for (Network network : manager.getAllNetworks()) {
            NetworkCapabilities caps = manager.getNetworkCapabilities(network);
            LinkProperties properties = manager.getLinkProperties(network);
            if (caps == null || properties == null || !caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)
                    || !caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_VPN)) continue;
            for (LinkAddress link : properties.getLinkAddresses()) {
                if (!(link.getAddress() instanceof Inet4Address)) continue;
                try { NodeAddress.validate(link.getAddress().getHostAddress()); return link.getAddress(); }
                catch (IllegalArgumentException ignored) { }
            }
        }
        throw new AssertionError("Native socket test requires a private IPv4 Wi-Fi network (provided by the CI emulator)");
    }

    private ByteString hello() {
        return ByteString.of(ByteBuffer.allocate(26).order(ByteOrder.LITTLE_ENDIAN)
                .put((byte) 0x29).put(new byte[16]).putInt(42).putInt(7).put((byte) 0).array());
    }
    private ByteString info(int permission) {
        return ByteString.of(ByteBuffer.allocate(21).order(ByteOrder.LITTLE_ENDIAN)
                .put((byte) 0x21).put((byte) 2).putInt(42).put(new byte[6])
                .put((byte) 6).put((byte) 0).put((byte) 2).put((byte) permission).putInt(7).put((byte) 0).array());
    }

    @Test public void wifiHandshakeEncryptedSendLivePermissionsAndDisconnect() throws Exception {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        vault = new SecureVault(context);
        assumeTrue("Existing accounts are preserved", vault.load() == null);
        InetAddress address = wifiAddress(context);
        AtomicInteger permission = new AtomicInteger(0);
        LinkedBlockingQueue<ByteString> auth = new LinkedBlockingQueue<>();
        LinkedBlockingQueue<ByteString> messages = new LinkedBlockingQueue<>();
        server = new MockWebServer();
        server.enqueue(new MockResponse().withWebSocketUpgrade(new WebSocketListener() {
            @Override public void onOpen(WebSocket socket, Response response) { node = socket; socket.send(hello()); }
            @Override public void onMessage(WebSocket socket, ByteString bytes) {
                int type = bytes.getByte(0) & 0xff;
                if (type == 0x14) { auth.add(bytes); socket.send(ByteString.of(new byte[] { 0x2a, 2, 0 })); }
                else if (type == 0x11) socket.send(info(permission.get()));
                else if (type == 0x10 && bytes.size() > 3 && bytes.getByte(1) == 2) messages.add(bytes);
                else if (type != 0x10) socket.close(1008, "Unexpected command");
            }
        }));
        // Production uses fixed port 81; bind only this device's Wi-Fi address.
        server.start(address, 81);
        byte[] secret = new byte[32];
        new SecureRandom().nextBytes(secret);
        // Public test contact: X25519(secret=32 bytes of 7), BLAKE2b-64 fingerprint.
        JSONObject contact = new JSONObject().put("fp", "108350c737e9ffd3")
                .put("pubkey", "E75P6uryBMf9M1j8nAByGIHRdCeBKCJ+xnTzf3/pe20=")
                .put("signPk", JSONObject.NULL).put("name", "Fixture Bob").put("verified", false)
                .put("firstSeen", 0).put("lastSeen", 0);
        vault.save(new JSONObject().put("version", 1).put("name", name).put("secret", Base64.encodeToString(secret, Base64.NO_WRAP))
                .put("host", address.getHostAddress()).put("contacts", new JSONArray().put(contact)).put("messages", new JSONArray()).toString());
        scenario = ActivityScenario.launch(MainActivity.class);
        waitForText("h1", "Conversations");
        onWebView().withElement(findElement(Locator.CSS_SELECTOR, "nav button:nth-child(2)")).perform(webClick());
        onWebView().withElement(findElement(Locator.CSS_SELECTOR, ".panel .primary")).perform(webClick());
        waitForText(".status-pill", "LINK ESTABLISHED");
        ByteString signedAuth = auth.poll(5, TimeUnit.SECONDS);
        assertNotNull("Native socket must carry guest authentication", signedAuth);
        assertEquals(97, signedAuth.size());
        waitForText(".panel", "Read-only access");

        permission.set(1);
        waitForText(".panel", "Guest access");
        permission.set(0);
        waitForText(".panel", "Read-only access");
        permission.set(1);
        waitForText(".panel", "Guest access");
        onWebView().withElement(findElement(Locator.CSS_SELECTOR, "nav button:first-child")).perform(webClick());
        onWebView().withElement(findElement(Locator.CSS_SELECTOR, ".contact-row")).perform(webClick());
        onView(isAssignableFrom(WebView.class)).perform(click());
        onWebView().withElement(findElement(Locator.ID, "message")).perform(webClick());
        String text = "Encrypted native socket message";
        onView(isAssignableFrom(WebView.class)).perform(typeTextIntoFocusedView(text), closeSoftKeyboard());
        long sentAt = SystemClock.uptimeMillis();
        onWebView().withElement(findElement(Locator.CSS_SELECTOR, ".send-button")).perform(webClick());
        ByteString encrypted = messages.poll(5, TimeUnit.SECONDS);
        assertNotNull("Composed message must reach the node through the native Wi-Fi socket", encrypted);
        assertEquals(228, encrypted.size());
        assertFalse("Message text must not appear on the wire", encrypted.utf8().contains(text));
        waitForText(".message", text);
        assertEquals("sending", new JSONObject(vault.load()).getJSONArray("messages").getJSONObject(0).getString("state"));
        node.close(1000, "Fixture disconnected");
        waitForText(".offline-note", "Connect to a node");
        waitForText(".message-state", "Not delivered");
        assertTrue("Disconnect must fail the pending message before the independent ten-second retry timeout",
                SystemClock.uptimeMillis() - sentAt < 5000);
        assertEquals("failed", new JSONObject(vault.load()).getJSONArray("messages").getJSONObject(0).getString("state"));
    }
}
