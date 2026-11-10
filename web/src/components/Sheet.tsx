import { animate, motionValue, type AnimationPlaybackControls } from 'motion';
import { useCallback, useEffect, useLayoutEffect, useRef, type ReactNode } from 'react';

// Apple's momentum projection: where would this gesture come to rest if it kept decelerating?
const project = (velocity: number, rate = 0.998) => ((velocity / 1000) * rate) / (1 - rate);
// Progressive resistance past a boundary instead of a hard stop.
const rubberband = (over: number, dim: number, c = 0.55) => (over * dim * c) / (dim + c * Math.abs(over));

const prefersReduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const isPhone = () => matchMedia('(max-width: 760px)').matches;

interface Props {
  label: string;
  onClosed: () => void;
  children: (close: () => void) => ReactNode;
  wide?: boolean;
}

/**
 * A modal surface. On a phone it rises from the bottom and can be dragged or flicked away;
 * on a desktop it slides in from the right. It leaves the way it came, the motion is a
 * critically damped spring, and it can be grabbed or reversed at any point.
 */
export function Sheet({ label, onClosed, children, wide }: Props) {
  const panel = useRef<HTMLDivElement>(null);
  const scrim = useRef<HTMLDivElement>(null);
  const offset = useRef(motionValue(0)); // px away from the resting position, along the entry axis
  const playing = useRef<AnimationPlaybackControls | null>(null);
  const closing = useRef(false);
  const phone = useRef(isPhone());

  const extent = () => {
    const el = panel.current!;
    return phone.current ? el.offsetHeight : el.offsetWidth + 24;
  };

  const springTo = useCallback((target: number, velocity = 0, done?: () => void) => {
    playing.current?.stop();
    if (prefersReduced()) {
      offset.current.set(target);
      done?.();
      return;
    }
    // Starts from the live value and carries the gesture's velocity, so there is no seam.
    playing.current = animate(offset.current, target, { type: 'spring', bounce: 0, duration: 0.42, velocity, onComplete: done });
  }, []);

  const close = useCallback((velocity = 0) => {
    if (closing.current) return;
    closing.current = true;
    if (prefersReduced()) panel.current?.classList.add('is-fading');
    springTo(extent(), velocity, onClosed);
    if (prefersReduced()) setTimeout(onClosed, 160);
  }, [onClosed, springTo]);

  useLayoutEffect(() => {
    const el = panel.current!;
    const apply = (v: number) => {
      el.style.transform = phone.current ? `translate3d(0, ${v}px, 0)` : `translate3d(${v}px, 0, 0)`;
      if (scrim.current) scrim.current.style.opacity = String(Math.max(0, Math.min(1, 1 - v / extent())));
    };
    const unsub = offset.current.on('change', apply);
    offset.current.set(prefersReduced() ? 0 : extent());
    apply(offset.current.get());
    springTo(0);
    el.focus({ preventScroll: true });
    return () => { unsub(); playing.current?.stop(); };
  }, [springTo]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [close]);

  // Drag to dismiss (phone only): track 1:1, resist upward, decide from where the flick is heading.
  const drag = useRef<{ startY: number; base: number; samples: { t: number; y: number }[] } | null>(null);
  const onPointerDown = (e: React.PointerEvent) => {
    if (!phone.current || closing.current) return;
    playing.current?.stop(); // grab it mid-flight
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { startY: e.clientY, base: offset.current.get(), samples: [{ t: e.timeStamp, y: e.clientY }] };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const raw = d.base + (e.clientY - d.startY);
    offset.current.set(raw < 0 ? -rubberband(-raw, extent()) : raw);
    d.samples.push({ t: e.timeStamp, y: e.clientY });
    if (d.samples.length > 6) d.samples.shift();
  };
  const onPointerUp = () => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    const first = d.samples[0]!;
    const last = d.samples[d.samples.length - 1]!;
    const velocity = last.t > first.t ? ((last.y - first.y) / (last.t - first.t)) * 1000 : 0; // px/s
    const landing = offset.current.get() + project(velocity);
    if (landing > extent() * 0.5) close(velocity);
    else springTo(0, velocity);
  };

  return (
    <div className="sheet-layer">
      <div className="sheet-scrim" ref={scrim} onClick={() => close()} />
      <div className={`sheet${wide ? ' sheet-wide' : ''}`} ref={panel} role="dialog" aria-modal="true" aria-label={label} tabIndex={-1}>
        <div className="sheet-grab" onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}>
          <span />
        </div>
        <div className="sheet-body">{children(() => close())}</div>
      </div>
    </div>
  );
}
