# Home Wi-Fi mode

**Experimental.** Message other MeshLink apps on your router, with no boards. Turn it on in **Settings → Wi-Fi nodes → Experimental**, then choose **Connect → Home Wi-Fi**. It may change or break between versions.

## How it works

Each app broadcasts the same air frames a node would send over the radio, as UDP datagrams on port 4211, to the other apps on the same subnet. Everyone on the same MeshLink network (the one selected in the app) hears each other. Direct messages, rooms, announces and safety numbers work as before. The wire format is in [PROTOCOL.md](../PROTOCOL.md), section 2.6.

It does not reach other subnets, other houses or the internet. For that you still need nodes, or the radio.

## What it shows your Wi-Fi

Everyone on the same Wi-Fi can see that MeshLink is running, how often you send, and a random id for each session. Your announces carry your display name and public keys in clear, as on the radio, so they can see those too. They cannot read messages. Stealth mode stops beacons and automatic announces. The app skips VPN, virtual-switch and container adapters so it does not announce itself into those networks. Read [privacy.md](privacy.md) before you use it on a Wi-Fi you do not trust.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| "Connect to your home Wi-Fi or Ethernet first." | The PC has no private IPv4 address on a real adapter. |
| "Could not listen on port 4211" / "Port 4211 is in use" | Another program uses the port, often a second copy of MeshLink. Windows also reports this when its firewall blocks MeshLink: allow it on Private networks. |
| "No one else on this Wi-Fi yet" | The other app is not in Home Wi-Fi mode, uses a different MeshLink network, or the router blocks it. |
| Works over Ethernet, not Wi-Fi | The router isolates Wi-Fi clients (called AP isolation or client isolation). Guest networks do this by default. |
| Works only one way | Windows Firewall. Allow MeshLink on **Private** networks, and make sure Windows calls this network Private, not Public. |
| Messages arrive on the radio but not on the router (or the reverse) | A single app uses one link at a time. Home Wi-Fi and a node cannot run together yet. |

## Manual test on Windows (two PCs)

CI checks the portable code and real UDP on loopback. It cannot check Windows adapters or the firewall, so test these by hand before a release:

1. Put two PCs on the same home Wi-Fi. Mark the network **Private**.
2. On both, create or join the same MeshLink network (or use the open network).
3. On PC A choose **Connect → Home Wi-Fi**. Read the note, then **Connect**. Allow the firewall prompt for Private networks.
4. Do the same on PC B. Within about 30 seconds each should list the other under Contacts. Compare safety numbers.
5. Send a DM from A to B. B receives it and A shows **delivered**.
6. Create a public room on both, send a message each way.
7. Switch PC B to Ethernet (or a different adapter). It should keep working after a rescan of up to 30 seconds. Unplug everything: the app should report "The home network connection was lost."
8. With a VPN connected on one PC, check (for example with Wireshark) that no port 4211 traffic leaves through the VPN adapter.
9. Put PC B on a different MeshLink network. A must not show B and must not receive its messages.
10. Turn stealth on. The other PC should stop seeing this PC as nearby (no beacons), and DMs still work.
