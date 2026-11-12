import type { SVGProps } from 'react'

const base = (d: React.ReactNode) => (p: SVGProps<SVGSVGElement>) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" {...p}>
    {d}
  </svg>
)

export const IconShelf = base(<><path d="M4 19.5V5a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v14.5" /><path d="M9 19.5V7a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v12.5" /><path d="m14.5 6.6 2.8-.8a1 1 0 0 1 1.2.7l3 11.6" /><path d="M2.5 19.5h19" /></>)
export const IconCloud = base(<><path d="M7 18a4.5 4.5 0 0 1-.6-8.96A6 6 0 0 1 18 8.5a4.75 4.75 0 0 1-.5 9.5Z" /></>)
export const IconSync = base(<><path d="M20 11a8 8 0 0 0-14.3-4.9L4 8" /><path d="M4 4v4h4" /><path d="M4 13a8 8 0 0 0 14.3 4.9L20 16" /><path d="M20 20v-4h-4" /></>)
export const IconSettings = base(<><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z" /></>)
export const IconPlus = base(<><path d="M12 5v14M5 12h14" /></>)
export const IconBack = base(<><path d="m15 18-6-6 6-6" /></>)
export const IconList = base(<><path d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01" /></>)
export const IconBookmark = base(<><path d="M6 3.5h12a.5.5 0 0 1 .5.5v16.5l-6.5-4-6.5 4V4a.5.5 0 0 1 .5-.5Z" /></>)
export const IconBookmarkFill = (p: SVGProps<SVGSVGElement>) => (
  <svg viewBox="0 0 24 24" fill="currentColor" {...p}><path d="M6 3h12a1 1 0 0 1 1 1v17l-7-4.3L5 21V4a1 1 0 0 1 1-1Z" /></svg>
)
export const IconType = base(<><path d="M4 7V5h11v2M9.5 5v14M7 19h5" /><path d="M14 12v-1.5h7V12M17.5 10.5V19M16 19h3" /></>)
export const IconSun = base(<><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></>)
export const IconMoon = base(<><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z" /></>)
export const IconTrash = base(<><path d="M4 7h16M10 11v6M14 11v6M5.5 7l1 12a2 2 0 0 0 2 2h7a2 2 0 0 0 2-2l1-12M9 7V4h6v3" /></>)
export const IconChevronL = base(<><path d="m15 18-6-6 6-6" /></>)
export const IconChevronR = base(<><path d="m9 18 6-6-6-6" /></>)
export const IconChevronUp = base(<><path d="m6 15 6-6 6 6" /></>)
export const IconChevronDown = base(<><path d="m6 9 6 6 6-6" /></>)
export const IconTag = base(<><path d="M3.5 12.2V5a1.5 1.5 0 0 1 1.5-1.5h7.2a1.5 1.5 0 0 1 1.06.44l7.3 7.3a1.5 1.5 0 0 1 0 2.12l-7.2 7.2a1.5 1.5 0 0 1-2.12 0l-7.3-7.3a1.5 1.5 0 0 1-.44-1.06Z" /><circle cx="8" cy="8" r="1.3" /></>)
export const IconSort = base(<><path d="M4 7h13M4 12h9M4 17h5" /><path d="M18 10v9M15 16l3 3 3-3" /></>)
export const IconX = base(<><path d="M18 6 6 18M6 6l12 12" /></>)
export const IconCheck = base(<><path d="m5 12 5 5L20 7" /></>)
export const IconDownload = base(<><path d="M12 4v11M7 10l5 5 5-5M5 20h14" /></>)
export const IconGrid = base(<><rect x="4" y="4" width="6.5" height="6.5" rx="1.5" /><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.5" /><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.5" /><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.5" /></>)
export const IconFolder = base(<><path d="M3.5 7.5A1.5 1.5 0 0 1 5 6h4l2 2h8a1.5 1.5 0 0 1 1.5 1.5v8A1.5 1.5 0 0 1 19 19H5a1.5 1.5 0 0 1-1.5-1.5z" /></>)
export const IconFullscreen = base(<><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" /></>)
export const IconEdit = base(<><path d="M4 20h4L19.5 8.5a2.1 2.1 0 0 0-3-3L5 17z" /><path d="m14.5 7.5 3 3" /></>)
export const IconTransfer = base(<><path d="M7 4v14M3.5 14.5 7 18l3.5-3.5" /><path d="M17 20V6M13.5 9.5 17 6l3.5 3.5" /></>)
export const IconChart = base(<><path d="M4 20V10M10 20V4M16 20v-7M22 20H2" /></>)
export const IconSearch = base(<><circle cx="11" cy="11" r="6.5" /><path d="m20 20-4.2-4.2" /></>)
export const IconHighlight = base(<><path d="m9 11 6-6 4 4-6 6M9 11l-3 3v4h4l3-3M9 11l4 4" /><path d="M4 21h16" /></>)
export const IconNote = base(<><path d="M5 4h14v11l-5 5H5z" /><path d="M14 20v-5h5M8.5 9h7M8.5 12.5h4" /></>)
export const IconFont = base(<><path d="m4 20 6-16h1l6 16M6.5 14h8" /><path d="M18 20v-6" /></>)
