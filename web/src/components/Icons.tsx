import type { ReactNode } from 'react';

const Svg = ({ children, size = 20 }: { children: ReactNode; size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {children}
  </svg>
);
export const ChevronLeft = () => <Svg><path d="M15 5l-7 7 7 7" /></Svg>;
export const ChevronRight = () => <Svg><path d="M9 5l7 7-7 7" /></Svg>;
export const Plus = () => <Svg><path d="M12 5v14M5 12h14" /></Svg>;
export const Close = () => <Svg size={16}><path d="M6 6l12 12M18 6L6 18" /></Svg>;
export const Check = ({ size = 14 }: { size?: number }) => <Svg size={size}><path d="M5 12.5l4.5 4.5L19 7.5" /></Svg>;
export const Sliders = () => <Svg><path d="M4 7h10M18 7h2M4 17h2M10 17h10" /><circle cx="16" cy="7" r="2" /><circle cx="8" cy="17" r="2" /></Svg>;
export const Tray = () => <Svg><path d="M3 13l2.5-7.5h13L21 13v5a1.5 1.5 0 01-1.5 1.5h-15A1.5 1.5 0 013 18v-5z" /><path d="M3 13h5.5a3.5 3.5 0 007 0H21" /></Svg>;
export const IconToday = () => <Svg size={22}><rect x="4" y="5" width="16" height="15" rx="3" /><path d="M4 10h16M8.5 3v4M15.5 3v4" /><circle cx="12" cy="15" r="1.2" fill="currentColor" /></Svg>;
export const IconWeek = () => <Svg size={22}><rect x="3" y="5" width="18" height="14" rx="3" /><path d="M9 5v14M15 5v14" /></Svg>;
export const IconMonth = () => <Svg size={22}><rect x="3" y="4" width="18" height="16" rx="3" /><path d="M3 9.5h18M3 14.5h18M9 9.5V20M15 9.5V20" /></Svg>;
export const IconProjects = () => <Svg size={22}><path d="M4 6.5h9M4 12h13M4 17.5h6" /><circle cx="17" cy="6.5" r="1.6" /><circle cx="20" cy="12" r="0" /><circle cx="14" cy="17.5" r="1.6" /></Svg>;
export const Sparkle = () => <Svg><path d="M12 3.5l1.7 4.8 4.8 1.7-4.8 1.7L12 16.5l-1.7-4.8L5.5 10l4.8-1.7L12 3.5z" /><path d="M18.5 15.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7.7-1.8z" /></Svg>;
export const Paperclip = () => <Svg><path d="M20 11.5l-7.8 7.8a5 5 0 01-7.1-7.1l8.2-8.2a3.4 3.4 0 014.8 4.8l-8.1 8.1a1.8 1.8 0 01-2.5-2.5l7.4-7.4" /></Svg>;
export const ArrowUp = () => <Svg size={18}><path d="M12 19V6M6 11.5L12 5.5l6 6" /></Svg>;
export const IconAgenda = () => <Svg size={22}><path d="M8.5 7h11M8.5 12h11M8.5 17h11" /><circle cx="4.5" cy="7" r="1" fill="currentColor" /><circle cx="4.5" cy="12" r="1" fill="currentColor" /><circle cx="4.5" cy="17" r="1" fill="currentColor" /></Svg>;
