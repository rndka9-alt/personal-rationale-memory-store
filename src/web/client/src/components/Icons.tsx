type IconProps = {
  className?: string;
};

function IconFrame(props: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      aria-hidden="true"
      className={props.className}
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {props.children}
    </svg>
  );
}

export function ArchiveIcon(props: IconProps) {
  return (
    <IconFrame {...props}>
      <path d="M4 7.5h16" />
      <path d="M6 7.5v11h12v-11" />
      <path d="M4.5 4h15v3.5h-15z" />
      <path d="M9.5 11.5h5" />
    </IconFrame>
  );
}

export function ArrowLeftIcon(props: IconProps) {
  return (
    <IconFrame {...props}>
      <path d="M19 12H5" />
      <path d="m11 18-6-6 6-6" />
    </IconFrame>
  );
}

export function ChevronLeftIcon(props: IconProps) {
  return (
    <IconFrame {...props}>
      <path d="m15 18-6-6 6-6" />
    </IconFrame>
  );
}

export function ChevronRightIcon(props: IconProps) {
  return (
    <IconFrame {...props}>
      <path d="m9 18 6-6-6-6" />
    </IconFrame>
  );
}

export function DigestIcon(props: IconProps) {
  return (
    <IconFrame {...props}>
      <path d="M5 5.5h14M5 10h9M5 14.5h14M5 19h9" />
      <path d="M18 9.5v5" />
    </IconFrame>
  );
}

export function MemoryIcon(props: IconProps) {
  return (
    <IconFrame {...props}>
      <path d="M7 5.5A2.5 2.5 0 0 1 9.5 3h7A2.5 2.5 0 0 1 19 5.5v13A2.5 2.5 0 0 0 16.5 16h-7A2.5 2.5 0 0 0 7 18.5z" />
      <path d="M7 5.5v13A2.5 2.5 0 0 0 4.5 16H4V5.5A2.5 2.5 0 0 1 6.5 3H9" />
    </IconFrame>
  );
}

export function LlmIcon(props: IconProps) {
  return (
    <IconFrame {...props}>
      <path d="M4 16V9M8 19V5M12 16V9M16 20V4M20 16V8" />
    </IconFrame>
  );
}

export function NoteIcon(props: IconProps) {
  return (
    <IconFrame {...props}>
      <path d="M6 3.5h9l3 3v14H6z" />
      <path d="M15 3.5v3h3" />
      <path d="M9 11h6M9 15h6" />
    </IconFrame>
  );
}

export function RecapIcon(props: IconProps) {
  return (
    <IconFrame {...props}>
      <path d="M4.5 12a7.5 7.5 0 1 0 2.1-5.2L4.5 8.9" />
      <path d="M4.5 4.4v4.5H9" />
      <path d="M12 8.5V12l2.8 1.7" />
    </IconFrame>
  );
}

export function RestoreIcon(props: IconProps) {
  return (
    <IconFrame {...props}>
      <path d="M4 12a8 8 0 1 0 2.3-5.7L4 8.6" />
      <path d="M4 4v4.6h4.6" />
    </IconFrame>
  );
}

export function SearchIcon(props: IconProps) {
  return (
    <IconFrame {...props}>
      <circle cx="10.8" cy="10.8" r="6.3" />
      <path d="m16 16 4 4" />
    </IconFrame>
  );
}

export function XIcon(props: IconProps) {
  return (
    <IconFrame {...props}>
      <path d="m6 6 12 12M18 6 6 18" />
    </IconFrame>
  );
}
