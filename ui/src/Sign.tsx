// The customer's signature, drawn with a finger or a pen. The strokes are kept as fractions of the
// pad, so the drawing survives a turn of the phone, and the file made from them is the same
// whatever the screen.

import { type PointerEvent, useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@ferrum/kit";

type Point = [number, number];

const WIDTH = 600;
const HEIGHT = 240;

function trace(g: CanvasRenderingContext2D, strokes: Point[][], w: number, h: number, line: number) {
  g.lineWidth = line;
  g.lineCap = "round";
  g.lineJoin = "round";
  for (const s of strokes) {
    g.beginPath();
    s.forEach(([x, y], i) => (i ? g.lineTo(x * w, y * h) : g.moveTo(x * w, y * h)));
    // A tap is a dot.
    if (s.length === 1) g.lineTo(s[0][0] * w + 0.01, s[0][1] * h);
    g.stroke();
  }
}

/** The signature as a picture: dark on white whatever the theme, because it is a document that is
 *  printed and sent, not a part of the screen. */
function picture(strokes: Point[][]): Promise<Blob | null> {
  const c = document.createElement("canvas");
  c.width = WIDTH;
  c.height = HEIGHT;
  const g = c.getContext("2d");
  if (!g) return Promise.resolve(null);
  g.fillStyle = "#ffffff";
  g.fillRect(0, 0, WIDTH, HEIGHT);
  g.strokeStyle = "#000000";
  trace(g, strokes, WIDTH, HEIGHT, 3);
  return new Promise((resolve) => c.toBlob(resolve, "image/png"));
}

export function SignaturePad({ busy, blocked, onSave }: { busy: boolean; /** Why it cannot be saved yet, if it cannot. */ blocked?: string; onSave: (png: Blob) => void }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const strokes = useRef<Point[][]>([]);
  const drawing = useRef(false);
  const [ink, setInk] = useState(false);

  const paint = useCallback(() => {
    const c = canvas.current;
    const g = c?.getContext("2d");
    if (!c || !g) return;
    const ratio = window.devicePixelRatio || 1;
    const [w, h] = [c.clientWidth, c.clientHeight];
    if (c.width !== Math.round(w * ratio) || c.height !== Math.round(h * ratio)) {
      c.width = Math.round(w * ratio);
      c.height = Math.round(h * ratio);
    }
    g.setTransform(ratio, 0, 0, ratio, 0, 0);
    g.clearRect(0, 0, w, h);
    // The pad's own text colour, so the ink is readable on either theme.
    g.strokeStyle = getComputedStyle(c).color;
    trace(g, strokes.current, w, h, 2.5);
  }, []);

  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    paint();
    const watch = new ResizeObserver(paint);
    watch.observe(c);
    return () => watch.disconnect();
  }, [paint]);

  const at = (e: PointerEvent<HTMLCanvasElement>): Point => {
    const r = e.currentTarget.getBoundingClientRect();
    return [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height];
  };
  const down = (e: PointerEvent<HTMLCanvasElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    drawing.current = true;
    strokes.current.push([at(e)]);
    setInk(true);
    paint();
  };
  const move = (e: PointerEvent<HTMLCanvasElement>) => {
    if (!drawing.current) return;
    strokes.current[strokes.current.length - 1].push(at(e));
    paint();
  };
  const up = () => {
    drawing.current = false;
  };
  const clear = () => {
    strokes.current = [];
    setInk(false);
    paint();
  };
  const save = async () => {
    const png = await picture(strokes.current);
    if (png) onSave(png);
  };

  return (
    <div className="fs-pad">
      <canvas
        ref={canvas}
        className="fs-pad-canvas"
        role="img"
        aria-label="Signature area: the customer signs here with a finger or a pen"
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={up}
      />
      <div className="fs-pad-foot">
        <span className="faint">{blocked && ink ? blocked : ink ? "Signed" : "Sign above"}</span>
        <Button size="sm" onClick={clear} disabled={!ink || busy}>
          Clear
        </Button>
        <Button size="sm" variant="primary" loading={busy} disabled={!ink || !!blocked} onClick={() => void save()}>
          Save the signature
        </Button>
      </div>
    </div>
  );
}
