package dev.imbloxi.nodelink;

import org.junit.Test;
import static org.junit.Assert.*;

public class NodeAddressTest {
    @Test public void acceptsPrivateLiteralAddresses() {
        for (String host : new String[]{"192.168.4.1", "10.1.2.3", "172.16.0.1", "172.31.254.1"}) {
            assertEquals(host, NodeAddress.validate(host));
        }
    }
    @Test public void rejectsPublicLoopbackDnsAndAmbiguousInputs() {
        for (String host : new String[]{"example.com", "8.8.8.8", "127.0.0.1", "172.32.0.1", "192.168.999.1", "192.168.4.1:81", "010.0.0.1", "10.1.2.255", "10.1.2.0", "10.0.0.1/"}) {
            assertThrows(IllegalArgumentException.class, () -> NodeAddress.validate(host));
        }
    }
}
