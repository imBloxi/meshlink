/** Three linked nodes: the mesh. */
export function LogoMark({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden>
      <rect width="32" height="32" rx="9" fill="var(--accent)" />
      <g stroke="var(--accent-fg)" strokeWidth="2" strokeLinecap="round" opacity="0.55">
        <path d="M10 21 16 10 22 21Z" fill="none" />
      </g>
      <g fill="var(--accent-fg)">
        <circle cx="16" cy="10" r="3.2" />
        <circle cx="10" cy="21" r="3.2" />
        <circle cx="22" cy="21" r="3.2" />
      </g>
    </svg>
  );
}

export function Logo() {
  return (
    <div className="relative flex items-center gap-2.5">
      <LogoMark />
      <span className="text-[17px] font-semibold tracking-tight">MeshLink</span>
    </div>
  );
}
