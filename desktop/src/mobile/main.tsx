import { useEffect, useRef, useState, type FormEvent } from "react";
import { createRoot } from "react-dom/client";
import { ArrowLeft, ArrowUpRight, Check, CheckCheck, ChevronRight, Fingerprint, KeyRound, LoaderCircle, MessageCircle, Radio, Send, ShieldCheck, Unplug, UserRound, Wifi, X } from "lucide-react";
import { formatFp, safetyNumber } from "../core/identity";
import type { ChatMessage } from "../core/messenger";
import { backgroundApp, isAndroid, openWifi } from "./host";
import { clearError, connect, contactBytes, createAccount, disconnect, eraseAccount, initialize, sendMessage, useMobile, verifyContact } from "./session";
import "./styles.css";

function Brand() { return <span className="brand-mark" aria-hidden="true"><Radio size={25} strokeWidth={1.6} /></span>; }
function ErrorBanner({ text, dismiss }: { text: string; dismiss?: () => void }) {
  return <div className="error" role="alert"><span>{text}</span>{dismiss && <button className="icon-button" aria-label="Dismiss error" onClick={dismiss}><X size={17} /></button>}</div>;
}

function Welcome() {
  const [name, setName] = useState("");
  const [phrase, setPhrase] = useState("");
  const [restore, setRestore] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const storageError = useMobile((s) => s.storageError);
  const submit = (event: FormEvent) => {
    event.preventDefault(); setError(""); setBusy(true);
    try {
      if (restore && !phrase.trim()) throw new Error("Enter your 24-word recovery phrase.");
      createAccount(name, restore ? phrase : "");
    } catch (e) { setError(e instanceof Error ? e.message : "Could not create account."); }
    finally { setBusy(false); }
  };
  return <div className="welcome">
    <header className="welcome-header"><Brand /><span>NodeLink<small>MESHLINK FOR ANDROID</small></span><span className="version">EARLY ACCESS</span></header>
    <div className="welcome-art" aria-hidden="true"><div className="orbit orbit-one" /><div className="orbit orbit-two" /><span className="orbit-dot dot-one" /><span className="orbit-dot dot-two" /><Radio size={58} strokeWidth={1.2} /></div>
    <p className="eyebrow">A CONNECTION OF YOUR OWN</p>
    <h1>Stay close.<br /><em>Even off-grid.</em></h1>
    <p className="intro">Private messages, carried by nearby nodes.<br />No internet. No account server. Just your mesh.</p>
    <form onSubmit={submit} className="onboarding-form">
      <label htmlFor="name">What should people call you?</label>
      <input id="name" autoComplete="nickname" value={name} onChange={(e) => setName(e.target.value)} placeholder="Your display name" maxLength={32} required disabled={storageError || busy} />
      <p className="hint">Your name is visible to people on the mesh. It isn’t proof of identity.</p>
      {restore && <><label htmlFor="recovery">24-word recovery phrase</label><textarea id="recovery" autoComplete="off" autoCorrect="off" spellCheck={false} rows={4} value={phrase} onChange={(e) => setPhrase(e.target.value)} required /></>}
      {error && <ErrorBanner text={error} />}
      {!isAndroid() && <div className="info-card">Browser preview only. Account creation and node connections require the Android app’s secure storage.</div>}
      <button className="primary" disabled={busy || storageError || !isAndroid()} type="submit">{busy ? <LoaderCircle className="spin" size={18} /> : <ArrowUpRight size={18} />}{restore ? "Restore my identity" : "Create my identity"}</button>
      <button type="button" className="text-button" disabled={busy || storageError} onClick={() => { setRestore(!restore); setError(""); }}>{restore ? "Create a new identity instead" : "Already have a recovery phrase?"}</button>
    </form>
    <footer><ShieldCheck size={15} /><span>End-to-end encrypted. Keys stay on your phone.</span></footer>
  </div>;
}

function ConnectionCard({ onOpen }: { onOpen: () => void }) {
  const { status, node } = useMobile();
  return <button className={`connection-card ${status === "connected" ? "is-connected" : ""}`} onClick={onOpen}>
    <span className="connection-icon"><Wifi size={21} /></span>
    <span><strong>{status === "connected" ? node : status === "connecting" ? "Connecting to your node…" : "Your mesh is one tap away"}</strong><small>{status === "connected" ? "Connected over Wi-Fi · Guest access" : "Join a node to discover people nearby"}</small></span>
    <ChevronRight size={18} />
  </button>;
}
function Chats({ select, openNode }: { select: (fp: string) => void; openNode: () => void }) {
  const { contacts, messages, status } = useMobile();
  const [query, setQuery] = useState("");
  const filtered = contacts.filter((c) => `${c.name} ${c.fp}`.toLowerCase().includes(query.toLowerCase()));
  return <>
    <div className="page-title"><div><p className="eyebrow">YOUR PEOPLE, WITHIN REACH</p><h1>Conversations</h1></div><MessageCircle className="title-icon" size={26} /></div>
    <ConnectionCard onOpen={openNode} />
    <label className="sr-only" htmlFor="search">Search contacts</label><input className="search" id="search" placeholder="Find someone on your mesh" value={query} onChange={(e) => setQuery(e.target.value)} />
    <div className="section-heading"><span>ON YOUR MESH</span><span>{contacts.length} {contacts.length === 1 ? "person" : "people"}</span></div>
    <div className="contact-list">{filtered.map((contact) => {
      const last = messages.filter((m) => m.conv === `dm:${contact.fp}`).at(-1);
      return <button className="contact-row" key={contact.fp} onClick={() => select(contact.fp)}>
        <span className="avatar">{Array.from(contact.name || "?")[0].toUpperCase()}</span>
        <span className="contact-copy"><strong>{contact.name || "Unnamed contact"}{contact.verified && <ShieldCheck size={14} className="accent" aria-label="Verified contact" />}</strong><small>{last ? `${last.outgoing ? "You: " : ""}${last.text}` : "Say hello over the mesh"}</small></span>
        <span className="contact-meta">{last ? new Date(last.ts * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "NEW"}<ChevronRight size={15} /></span>
      </button>;
    })}</div>
    {!filtered.length && <div className="empty"><span className="empty-icon"><MessageCircle size={30} strokeWidth={1.3} /></span><h2>{query ? "No matching contacts" : "Good conversations start nearby"}</h2><p>{query ? "Try another name or fingerprint." : status === "connected" ? "Other people appear here when their apps announce on the same mesh. Keep both apps connected." : "Connect to a node and people on the same mesh will appear here."}</p>{!query && status === "offline" && <button className="secondary" onClick={openNode}>Find my node <ArrowUpRight size={16} /></button>}</div>}
    <div className="privacy-note"><ShieldCheck size={16} /><p>Nodes carry encrypted messages.<br />Only you and your contact can read them.</p></div>
  </>;
}
function NodePage() {
  const { status, host, node, permission } = useMobile();
  const [address, setAddress] = useState(host);
  const [error, setError] = useState("");
  const submit = (e: FormEvent) => { e.preventDefault(); void connect(address); };
  return <>
    <div className="page-title"><div><p className="eyebrow">YOUR BRIDGE TO THE MESH</p><h1>Connect a node</h1></div><Radio size={27} className="title-icon" /></div>
    <div className="node-visual"><span className={`node-radio ${status === "connected" ? "live" : ""}`}><Radio size={49} strokeWidth={1.25} /></span><span className="status-pill"><i className={status === "connected" ? "live-dot" : ""} />{status === "connected" ? "LINK ESTABLISHED" : status === "connecting" ? "ESTABLISHING LINK" : "WAITING FOR A NODE"}</span></div>
    {status === "connected" ? <section className="panel"><div className="section-heading"><span>CONNECTED NODE</span><ShieldCheck size={16} className="accent" /></div><h2>{node}</h2><p className="mono muted">{host}:81</p><p>{permission === 0 ? "Read-only access. The node’s admin has disabled sending." : "Guest access. Send encrypted direct messages to people on this mesh."}</p><button className="secondary" onClick={disconnect}><Unplug size={17} />Disconnect</button></section> : <>
      <section className="panel"><span className="step-number">01</span><h2>Join the node’s Wi-Fi</h2><p>Open Wi-Fi settings and join its MeshLink hotspot. If Android asks, stay connected without internet. Ask the node’s owner for the password.</p><button className="secondary" disabled={!isAndroid()} onClick={() => { try { openWifi(); } catch (e) { setError(String(e)); } }}><Wifi size={17} />Open Wi-Fi settings<ArrowUpRight size={16} /></button></section>
      <form className="panel" onSubmit={submit}><span className="step-number">02</span><h2>Make the connection</h2><p>The usual node address is filled in. Change it if your node uses a different private address.</p><label htmlFor="address">Node IP address</label><input id="address" value={address} onChange={(e) => setAddress(e.target.value)} inputMode="decimal" autoComplete="off" spellCheck={false} disabled={status === "connecting"} required /><button className="primary" disabled={status === "connecting" || !isAndroid()}>{status === "connecting" ? <LoaderCircle size={18} className="spin" /> : <Radio size={18} />}{status === "connecting" ? "Connecting…" : "Connect to node"}</button>{status === "connecting" && <button type="button" className="text-button" onClick={disconnect}>Cancel connection</button>}</form>
    </>}
    {error && <ErrorBanner text={error} dismiss={() => setError("")} />}
    <div className="info-card"><strong>Keep NodeLink open to receive.</strong><p>This first version connects while the app is in the foreground. Reconnect after returning from another app. Nodes do not store a mailbox for you.</p></div>
  </>;
}
function AccountPage() {
  const { identity, name } = useMobile();
  const [showPhrase, setShowPhrase] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState("");
  if (!identity) return null;
  return <>
    <div className="page-title"><div><p className="eyebrow">OWN YOUR IDENTITY</p><h1>Your account</h1></div><Fingerprint size={27} className="title-icon" /></div>
    <section className="panel identity-card"><span className="avatar large">{Array.from(name)[0]?.toUpperCase()}</span><h2>{name}</h2><p className="mono accent">{formatFp(identity.fp)}</p><p>This fingerprint identifies your encryption key. A display name alone cannot prove who someone is.</p></section>
    <section className="panel"><KeyRound size={22} className="accent" /><h2>Your recovery phrase</h2><p>These 24 words restore your identity. Write them down privately. Anyone with the phrase can access your identity.</p>{showPhrase && <p className="recovery-phrase mono">{identity.phrase()}</p>}<button className="secondary" onClick={() => setShowPhrase(!showPhrase)}>{showPhrase ? "Hide recovery phrase" : "Show recovery phrase"}</button></section>
    <section className="panel"><ShieldCheck size={22} className="accent" /><h2>Private on your phone</h2><p>Your account, contacts and up to 1,000 recent messages are encrypted with a key held in Android Keystore. The oldest messages are removed when local history fills up. Android backups and app screenshots are disabled.</p><p className="hint">This early version supports direct messages. Rooms, node administration, background delivery and USB flashing remain in the desktop app.</p></section>
    <section className="panel danger-panel"><h2>Remove this account</h2><p>This removes the local identity, contacts and history. Save your recovery phrase first; it restores your identity, not deleted messages.</p>{confirm ? <><p>Remove this account from this phone?</p><button className="danger-button" onClick={() => { try { eraseAccount(); } catch (e) { setError(String(e)); } }}>Yes, remove local account</button><button className="text-button" onClick={() => setConfirm(false)}>Keep account</button></> : <button className="danger-button" onClick={() => setConfirm(true)}>Remove local account</button>}</section>
    {error && <ErrorBanner text={error} />}
  </>;
}
function MessageStatus({ message }: { message: ChatMessage }) {
  if (!message.outgoing) return null;
  return <span className={`message-state ${message.state === "failed" ? "failed" : ""}`}>
    {message.state === "delivered" ? <CheckCheck size={13} /> : message.state === "sending" ? <LoaderCircle size={12} className="spin" /> : message.state === "failed" ? "Not delivered" : <Check size={13} />}
    <span className="sr-only">{message.state}</span>
  </span>;
}
function Conversation({ fp, back }: { fp: string; back: () => void }) {
  const { identity, contacts, messages, status, permission } = useMobile();
  const contact = contacts.find((c) => c.fp === fp);
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const [details, setDetails] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);
  const conversation = messages.filter((m) => m.conv === `dm:${fp}`);
  useEffect(() => { bottom.current?.scrollIntoView({ behavior: "instant" }); }, [messages.length, fp]);
  if (!contact || !identity) return null;
  const submit = (event: FormEvent) => {
    event.preventDefault(); setError("");
    try { sendMessage(fp, text); setText(""); } catch (e) { setError(e instanceof Error ? e.message : "Could not send."); }
  };
  return <div className="conversation">
    <header className="conversation-header"><button className="icon-button" aria-label="Back to conversations" onClick={back}><ArrowLeft size={22} /></button><span className="avatar small">{Array.from(contact.name || "?")[0].toUpperCase()}</span><button className="contact-heading" onClick={() => setDetails(!details)}><strong>{contact.name || "Unnamed contact"}</strong><small>{contact.verified ? "Verified in person" : "Identity not yet verified"}</small></button><button className="icon-button" aria-label="Verify contact identity" aria-expanded={details} onClick={() => setDetails(!details)}><ShieldCheck className={contact.verified ? "accent" : ""} size={22} /></button></header>
    {details && <section className="verification panel"><h2>Compare in person</h2><p>Compare this safety number with {contact.name} over a trusted channel. Only mark verified when every group matches.</p><p className="safety-number mono">{safetyNumber(identity.fp, contactBytes(fp))}</p><p className="mono hint">{formatFp(contactBytes(fp))}</p><button className="secondary" onClick={() => verifyContact(fp, !contact.verified)}><ShieldCheck size={17} />{contact.verified ? "Remove verification" : "Numbers match · Mark verified"}</button></section>}
    <div className="messages" role="log" aria-label={`Messages with ${contact.name}`} aria-live="polite">
      <p className="chat-privacy"><ShieldCheck size={13} />End-to-end encrypted</p>
      {!conversation.length && <div className="empty"><MessageCircle size={32} strokeWidth={1.3} /><h2>Start with a hello</h2><p>You both need to be connected to the same mesh to exchange messages.</p></div>}
      {conversation.map((message) => <div key={message.id} className={`message ${message.outgoing ? "outgoing" : "incoming"}`}><p>{message.text}</p><div className="message-meta"><time dateTime={new Date(message.ts * 1000).toISOString()}>{new Date(message.ts * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time><MessageStatus message={message} /></div></div>)}<div ref={bottom} />
    </div>
    {error && <ErrorBanner text={error} dismiss={() => setError("")} />}
    {status !== "connected" && <div className="offline-note">Connect to a node to send and receive messages.</div>}
    {status === "connected" && permission === 0 && <div className="offline-note">This node has granted read-only access.</div>}
    <form className="composer" onSubmit={submit}><label htmlFor="message" className="sr-only">Message</label><textarea id="message" rows={1} placeholder="Message over the mesh…" value={text} onChange={(e) => setText(e.target.value)} maxLength={1000} disabled={status !== "connected" || !permission} /><button className="send-button" type="submit" aria-label="Send message" disabled={!text.trim() || status !== "connected" || !permission}><Send size={19} /></button></form><div className="composer-note">{[...text].length}/500 · Delivery requires your contact to be online</div>
  </div>;
}
function App() {
  const { loaded, identity, status, error, storageError } = useMobile();
  const [tab, setTab] = useState<"chats" | "node" | "account">("chats");
  const [selected, setSelected] = useState<string | null>(null);
  useEffect(initialize, []);
  useEffect(() => {
    const back = () => {
      if (selected) setSelected(null);
      else if (tab !== "chats") setTab("chats");
      else if (isAndroid()) backgroundApp();
    };
    window.addEventListener("nodelink-back", back);
    return () => window.removeEventListener("nodelink-back", back);
  }, [selected, tab]);
  if (!loaded) return <div className="loading"><Brand /><p>Opening your encrypted account…</p></div>;
  return <div className="app-shell">
    {error && <ErrorBanner text={error} dismiss={storageError ? undefined : clearError} />}
    {!identity ? <Welcome /> : selected ? <Conversation key={selected} fp={selected} back={() => setSelected(null)} /> : <>
      <header className="app-header"><div className="brand"><Brand /><span>NodeLink<small>MESHLINK FOR ANDROID</small></span></div><span className={`header-status ${status === "connected" ? "online" : ""}`}><i />{status === "connected" ? "On mesh" : status === "connecting" ? "Linking" : "Offline"}</span></header>
      <main className="page">{tab === "chats" ? <Chats select={setSelected} openNode={() => setTab("node")} /> : tab === "node" ? <NodePage /> : <AccountPage />}</main>
      <nav className="bottom-nav" aria-label="Main navigation">{([{ id: "chats", title: "Chats", Icon: MessageCircle }, { id: "node", title: "Node", Icon: Radio }, { id: "account", title: "You", Icon: UserRound }] as const).map(({ id, title, Icon }) => <button key={id} aria-current={tab === id ? "page" : undefined} onClick={() => setTab(id)}><span><Icon size={22} strokeWidth={tab === id ? 2 : 1.6} /></span>{title}</button>)}</nav>
    </>}
  </div>;
}
createRoot(document.getElementById("root")!).render(<App />);
