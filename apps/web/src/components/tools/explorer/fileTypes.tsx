import type { FileEntry } from '@harv/shared';

export type IconKind =
  | 'folder'
  | 'drive'
  | 'image'
  | 'video'
  | 'audio'
  | 'pdf'
  | 'archive'
  | 'code'
  | 'doc'
  | 'sheet'
  | 'slide'
  | 'app'
  | 'link'
  | 'text'
  | 'file';

const ext = (name: string) => {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i + 1).toLowerCase() : '';
};

/** Windows Explorer's "Type" column. */
const TYPE_NAMES: Record<string, string> = {
  txt: 'Text Document',
  log: 'Text Document',
  md: 'Markdown File',
  pdf: 'PDF Document',
  png: 'PNG File',
  jpg: 'JPG File',
  jpeg: 'JPEG File',
  gif: 'GIF File',
  webp: 'WEBP File',
  bmp: 'BMP File',
  svg: 'SVG Document',
  ico: 'Icon',
  mp3: 'MP3 File',
  wav: 'WAV File',
  flac: 'FLAC File',
  mp4: 'MP4 File',
  mkv: 'MKV File',
  mov: 'MOV File',
  webm: 'WEBM File',
  zip: 'Compressed (zipped) Folder',
  '7z': '7Z File',
  rar: 'RAR File',
  exe: 'Application',
  msi: 'Windows Installer Package',
  lnk: 'Shortcut',
  url: 'Internet Shortcut',
  bat: 'Windows Batch File',
  cmd: 'Windows Command Script',
  ps1: 'Windows PowerShell Script',
  ini: 'Configuration settings',
  json: 'JSON File',
  js: 'JavaScript File',
  ts: 'TypeScript File',
  tsx: 'TSX File',
  py: 'Python File',
  html: 'HTML Document',
  css: 'CSS File',
  docx: 'Microsoft Word Document',
  doc: 'Microsoft Word 97-2003 Document',
  xlsx: 'Microsoft Excel Worksheet',
  xls: 'Microsoft Excel 97-2003 Worksheet',
  csv: 'CSV File',
  pptx: 'Microsoft PowerPoint Presentation',
  dll: 'Application extension',
  sys: 'System file',
};

export function typeName(e: Pick<FileEntry, 'name' | 'dir'>): string {
  if (e.dir) return 'File folder';
  const x = ext(e.name);
  return TYPE_NAMES[x] ?? (x ? `${x.toUpperCase()} File` : 'File');
}

const KINDS: [IconKind, RegExp][] = [
  ['image', /^(png|jpe?g|gif|webp|bmp|svg|ico|heic|tiff?)$/],
  ['video', /^(mp4|mkv|mov|avi|webm|wmv)$/],
  ['audio', /^(mp3|wav|flac|ogg|m4a|aac)$/],
  ['pdf', /^pdf$/],
  ['archive', /^(zip|7z|rar|tar|gz|iso)$/],
  ['code', /^(js|ts|tsx|jsx|py|rs|go|java|cs|cpp|c|h|html|css|json|ps1|bat|cmd|sh|yml|yaml|xml|toml)$/],
  ['doc', /^(docx?|odt|rtf)$/],
  ['sheet', /^(xlsx?|csv|ods)$/],
  ['slide', /^(pptx?|odp)$/],
  ['app', /^(exe|msi|dll|appx)$/],
  ['link', /^(lnk|url)$/],
  ['text', /^(txt|md|log|ini|cfg)$/],
];

export function iconKind(e: Pick<FileEntry, 'name' | 'dir'>): IconKind {
  if (e.dir) return 'folder';
  const x = ext(e.name);
  return KINDS.find(([, re]) => re.test(x))?.[0] ?? 'file';
}

export const isImage = (name: string) => /^(png|jpe?g|gif|webp|bmp|ico)$/.test(ext(name));
export const isPdf = (name: string) => ext(name) === 'pdf';
export const isMedia = (name: string) => /^(mp4|webm|mp3|wav)$/.test(ext(name));
export const isTextLike = (name: string) =>
  !/^(exe|dll|msi|zip|7z|rar|iso|bin|dat|db|sqlite|lnk|sys|tar|gz|docx?|xlsx?|pptx?|png|jpe?g|gif|webp|bmp|ico|pdf|mp4|webm|mp3|wav|mkv|mov|avi|flac)$/.test(
    ext(name),
  );

/** The "badge" colour and label drawn on a file icon. */
const BADGE: Partial<Record<IconKind, [string, string]>> = {
  image: ['#5BA4E6', 'IMG'],
  video: ['#B57BE8', 'VID'],
  audio: ['#E8A04C', '♪'],
  pdf: ['#E35D5D', 'PDF'],
  archive: ['#D9B64A', 'ZIP'],
  code: ['#6FBF8A', '</>'],
  doc: ['#4A7FD9', 'W'],
  sheet: ['#3FA16A', 'X'],
  slide: ['#D9714A', 'P'],
  app: ['#8FA3B8', 'EXE'],
  link: ['#8FA3B8', '↗'],
  text: ['#9AA7B4', 'TXT'],
};

/** A small Windows-like icon: yellow folders, paper sheets with a coloured type badge, drives. */
export function FileIcon({ kind, size = 18 }: { kind: IconKind; size?: number }) {
  if (kind === 'folder') {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" className="flex-none">
        <path
          d="M2 6.5A2.5 2.5 0 0 1 4.5 4h4.2l2 2.2h8.8A2.5 2.5 0 0 1 22 8.7V17.5A2.5 2.5 0 0 1 19.5 20h-15A2.5 2.5 0 0 1 2 17.5z"
          fill="#E8B84A"
        />
        <path d="M2 9.5h20v8A2.5 2.5 0 0 1 19.5 20h-15A2.5 2.5 0 0 1 2 17.5z" fill="#F6D06B" />
      </svg>
    );
  }
  if (kind === 'drive') {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" className="flex-none">
        <rect x="2" y="7" width="20" height="10" rx="2" fill="#7F8FA3" />
        <rect x="2" y="13" width="20" height="4" rx="1.5" fill="#5D6B7D" />
        <circle cx="18" cy="15" r="1" fill="#9FE0C4" />
      </svg>
    );
  }
  const badge = BADGE[kind];
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" className="flex-none">
      <path d="M6 2h8l5 5v13a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z" fill="#E8EDF2" />
      <path d="M14 2v5h5" fill="#C3CDD8" />
      {badge && (
        <>
          <rect x="3" y="12" width="15" height="7" rx="1.5" fill={badge[0]} />
          <text x="10.5" y="17.4" textAnchor="middle" fontSize="5.2" fontWeight="700" fill="#fff" fontFamily="sans-serif">
            {badge[1]}
          </text>
        </>
      )}
    </svg>
  );
}
