package dev.imbloxi.nodelink;

import android.content.Context;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.AtomicFile;
import java.io.File;
import java.io.FileOutputStream;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/** One bounded, atomic AES-GCM snapshot. Decryption failure never creates a new identity. */
final class SecureVault {
    private static final String ALIAS = "nodelink-vault-v1";
    private static final byte[] AAD = "nodelink-vault-v1".getBytes(StandardCharsets.UTF_8);
    private static final int MAX_BYTES = 4 * 1024 * 1024;
    private final AtomicFile file;
    private final String alias;
    SecureVault(Context context) {
        this(context, ALIAS);
    }
    SecureVault(Context context, String namespace) {
        alias = namespace;
        file = new AtomicFile(new File(context.getNoBackupFilesDir(), namespace + ".enc"));
    }
    private boolean exists() {
        return file.getBaseFile().exists() || new File(file.getBaseFile().getPath() + ".bak").exists();
    }
    private SecretKey key(boolean create) throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore");
        store.load(null);
        if (store.containsAlias(alias)) return (SecretKey) store.getKey(alias, null);
        if (!create) throw new IllegalStateException("The account encryption key is unavailable. Your encrypted account has been preserved.");
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        generator.init(new KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setKeySize(256).setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build());
        return generator.generateKey();
    }
    synchronized String load() throws Exception {
        if (!exists()) return null;
        if (file.getBaseFile().length() > MAX_BYTES + 64 || new File(file.getBaseFile().getPath() + ".bak").length() > MAX_BYTES + 64) {
            throw new IllegalStateException("Encrypted account exceeds the storage limit.");
        }
        byte[] blob = file.readFully();
        if (blob.length < 30 || blob[0] != 1) throw new IllegalStateException("Unsupported encrypted account format.");
        byte[] iv = new byte[12];
        System.arraycopy(blob, 1, iv, 0, 12);
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, key(false), new GCMParameterSpec(128, iv));
        cipher.updateAAD(AAD);
        return new String(cipher.doFinal(blob, 13, blob.length - 13), StandardCharsets.UTF_8);
    }
    synchronized void save(String value) throws Exception {
        if (value == null) throw new IllegalArgumentException("Missing account data.");
        byte[] data = value.getBytes(StandardCharsets.UTF_8);
        if (data.length > MAX_BYTES) throw new IllegalArgumentException("Local history exceeds the storage limit.");
        // Refuse to overwrite an unreadable existing vault or replace a lost key.
        if (exists()) load();
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, key(true));
        cipher.updateAAD(AAD);
        byte[] encrypted = cipher.doFinal(data);
        byte[] blob = ByteBuffer.allocate(1 + 12 + encrypted.length).put((byte) 1).put(cipher.getIV()).put(encrypted).array();
        FileOutputStream stream = null;
        try {
            stream = file.startWrite();
            stream.write(blob);
            file.finishWrite(stream);
        } catch (Exception error) {
            if (stream != null) file.failWrite(stream);
            throw error;
        }
    }
    synchronized void wipe() throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore");
        store.load(null);
        store.deleteEntry(alias);
        file.delete();
        if (exists()) throw new IllegalStateException("The encrypted account file could not be removed.");
    }
}
