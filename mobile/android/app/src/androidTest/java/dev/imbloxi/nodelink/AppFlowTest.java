package dev.imbloxi.nodelink;

import android.os.SystemClock;
import android.webkit.WebView;
import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import androidx.test.espresso.web.webdriver.Locator;
import org.json.JSONObject;
import org.junit.After;
import org.junit.Test;
import org.junit.runner.RunWith;
import java.util.UUID;
import static androidx.test.espresso.web.sugar.Web.onWebView;
import static androidx.test.espresso.Espresso.onView;
import static androidx.test.espresso.matcher.ViewMatchers.isAssignableFrom;
import static androidx.test.espresso.action.ViewActions.typeTextIntoFocusedView;
import static androidx.test.espresso.action.ViewActions.closeSoftKeyboard;
import static androidx.test.espresso.action.ViewActions.click;
import static androidx.test.espresso.web.webdriver.DriverAtoms.*;
import static androidx.test.espresso.web.assertion.WebViewAssertions.webMatches;
import static org.hamcrest.Matchers.containsString;
import static org.junit.Assert.*;
import static org.junit.Assume.assumeTrue;

/** Runs the packaged React UI against its real native bridge and Keystore. */
@RunWith(AndroidJUnit4.class)
public class AppFlowTest {
    private final String name = "Smoke-" + UUID.randomUUID().toString().substring(0, 8);
    private ActivityScenario<MainActivity> scenario;
    private SecureVault vault;

    @After public void cleanupOwnAccount() throws Exception {
        if (scenario != null) scenario.close();
        // Tests may run on a personal device: never replace or remove an existing account.
        if (vault != null) {
            String saved = vault.load();
            if (saved != null && name.equals(new JSONObject(saved).optString("name"))) vault.wipe();
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
            } catch (RuntimeException | AssertionError error) {
                last = error;
                SystemClock.sleep(150);
            }
        }
        String page = "unavailable";
        try { page = onWebView().withElement(findElement(Locator.CSS_SELECTOR, "body")).perform(getText()).get(); }
        catch (RuntimeException | AssertionError ignored) { }
        throw new AssertionError("Packaged app did not show " + selector + ": " + text + "; page=" + page.substring(0, Math.min(page.length(), 1500)), last);
    }

    @Test public void onboardingNavigationAndIdentitySurviveActivityRestart() throws Exception {
        vault = new SecureVault(InstrumentationRegistry.getInstrumentation().getTargetContext());
        assumeTrue("UI smoke test requires a fresh app install; existing accounts are preserved", vault.load() == null);
        scenario = ActivityScenario.launch(MainActivity.class);
        waitForText("h1", "Stay close.");
        // WebDriver's synthetic setter can bypass React's controlled-input
        // change tracking. Exercise the same native key events as a real user.
        // Give the native WebView focus before focusing its DOM input: a
        // JavaScript-only click does not focus the Android view for the IME.
        onView(isAssignableFrom(WebView.class)).perform(click());
        onWebView().withElement(findElement(Locator.ID, "name")).perform(webClick());
        onView(isAssignableFrom(WebView.class)).perform(typeTextIntoFocusedView(name), closeSoftKeyboard());
        onWebView().withElement(findElement(Locator.CSS_SELECTOR, "button[type='submit']")).perform(webClick());
        waitForText("h1", "Conversations");
        JSONObject created = new JSONObject(vault.load());
        assertEquals(name, created.getString("name"));
        String identity = created.getString("secret");
        onWebView().withElement(findElement(Locator.CSS_SELECTOR, "nav button:nth-child(2)")).perform(webClick());
        waitForText("h1", "Connect a node");
        onWebView().withElement(findElement(Locator.CSS_SELECTOR, "nav button:nth-child(3)")).perform(webClick());
        waitForText("h1", "Your account");
        waitForText(".identity-card h2", name);
        scenario.close();
        scenario = ActivityScenario.launch(MainActivity.class);
        waitForText("h1", "Conversations");
        assertEquals(identity, new JSONObject(vault.load()).getString("secret"));
        onWebView().withElement(findElement(Locator.CSS_SELECTOR, "nav button:nth-child(3)")).perform(webClick());
        waitForText(".identity-card h2", name);
    }
}
