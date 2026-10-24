package dev.imbloxi.nodelink;

/** Restrict the native bridge to explicit private Wi-Fi addresses, never DNS. */
final class NodeAddress {
    static String validate(String input) {
        if (input == null) throw new IllegalArgumentException("Missing node address.");
        String host = input.trim();
        String[] parts = host.split("\\.", -1);
        if (parts.length != 4) throw new IllegalArgumentException("Use a private IPv4 node address.");
        int[] octets = new int[4];
        for (int i = 0; i < 4; i++) {
            if (!parts[i].matches("0|[1-9][0-9]{0,2}")) throw new IllegalArgumentException("Invalid node address.");
            octets[i] = Integer.parseInt(parts[i]);
            if (octets[i] > 255) throw new IllegalArgumentException("Invalid node address.");
        }
        boolean local = octets[0] == 10 || (octets[0] == 172 && octets[1] >= 16 && octets[1] <= 31)
                || (octets[0] == 192 && octets[1] == 168);
        if (!local || octets[3] == 0 || octets[3] == 255) throw new IllegalArgumentException("Only private node addresses are allowed.");
        return host;
    }
}
