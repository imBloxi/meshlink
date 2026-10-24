package dev.imbloxi.nodelink;

import android.content.Context;
import androidx.test.platform.app.InstrumentationRegistry;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import org.junit.Before;
import org.junit.After;
import org.junit.Test;
import org.junit.runner.RunWith;
import static org.junit.Assert.*;
import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.KeyStore;
import java.util.UUID;

/** Uses its own Keystore alias and file; never reads or deletes the real account. */
@RunWith(AndroidJUnit4.class)
public class SecureVaultTest {
    private Context context;
    private String namespace;
    private SecureVault vault;
    private File file;
    @Before public void setUp() throws Exception {
        context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        namespace = "nodelink-test-" + UUID.randomUUID();
        vault = new SecureVault(context, namespace);
        file = new File(context.getNoBackupFilesDir(), namespace + ".enc");
    }
    @After public void tearDown() throws Exception {
        vault.wipe();
    }
    @Test public void testRoundTripPersistsEncryptedData() throws Exception {
        assertNull(vault.load());
        String secret = "PRIVATE_TEST_IDENTITY_AND_MESSAGE";
        vault.save(secret);
        byte[] first = Files.readAllBytes(file.toPath());
        assertFalse(new String(first, StandardCharsets.UTF_8).contains(secret));
        assertEquals(secret, new SecureVault(context, namespace).load());
        vault.save(secret);
        assertFalse(java.util.Arrays.equals(first, Files.readAllBytes(file.toPath())));
    }
    @Test public void testTamperingPreservesTheUnreadableFile() throws Exception {
        vault.save("first account");
        byte[] tampered = Files.readAllBytes(file.toPath());
        tampered[tampered.length - 1] ^= 1;
        Files.write(file.toPath(), tampered);
        try { vault.load(); fail("Tampered ciphertext must fail authentication"); } catch (javax.crypto.AEADBadTagException expected) { }
        try { vault.save("replacement"); fail("Unreadable accounts must not be overwritten"); } catch (javax.crypto.AEADBadTagException expected) { }
        assertTrue(java.util.Arrays.equals(tampered, Files.readAllBytes(file.toPath())));
    }
    @Test public void testMissingKeyDoesNotResetAccount() throws Exception {
        vault.save("original");
        byte[] original = Files.readAllBytes(file.toPath());
        KeyStore store = KeyStore.getInstance("AndroidKeyStore");
        store.load(null);
        store.deleteEntry(namespace);
        try { vault.load(); fail("Missing key must fail"); } catch (IllegalStateException expected) { }
        try { vault.save("new account"); fail("Missing key must not generate a replacement"); } catch (IllegalStateException expected) { }
        assertTrue(java.util.Arrays.equals(original, Files.readAllBytes(file.toPath())));
    }
}
