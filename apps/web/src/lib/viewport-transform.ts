export interface CanvasPoint {
  x: number;
  y: number;
}

export interface ViewportState {
  pan: CanvasPoint;
  zoom: number;
}

export const MIN_CANVAS_ZOOM = 0.12;
export const MAX_CANVAS_ZOOM = 3.2;

function requireFinite(value: number, label: string): number {
  if (!Number.isFinite(value)) throw new Error(`${label} must be finite.`);
  return value;
}

export function clampCanvasZoom(zoom: number): number {
  return Math.max(MIN_CANVAS_ZOOM, Math.min(MAX_CANVAS_ZOOM, requireFinite(zoom, "Zoom")));
}

/**
 * The only coordinate conversion contract used by the editor canvas.
 * World coordinates are canonical document values. Viewport coordinates are
 * CSS pixels relative to the untransformed editor root.
 */
export class ViewportTransform {
  readonly pan: CanvasPoint;
  readonly zoom: number;

  constructor(state: ViewportState) {
    this.pan = {
      x: requireFinite(state.pan.x, "Pan x"),
      y: requireFinite(state.pan.y, "Pan y"),
    };
    this.zoom = clampCanvasZoom(state.zoom);
  }

  worldToViewport(point: CanvasPoint): CanvasPoint {
    return {
      x: point.x * this.zoom + this.pan.x,
      y: point.y * this.zoom + this.pan.y,
    };
  }

  viewportToWorld(point: CanvasPoint): CanvasPoint {
    return {
      x: (point.x - this.pan.x) / this.zoom,
      y: (point.y - this.pan.y) / this.zoom,
    };
  }

  worldDeltaToViewport(delta: CanvasPoint): CanvasPoint {
    return { x: delta.x * this.zoom, y: delta.y * this.zoom };
  }

  viewportDeltaToWorld(delta: CanvasPoint): CanvasPoint {
    return { x: delta.x / this.zoom, y: delta.y / this.zoom };
  }

  withZoomAt(viewportPoint: CanvasPoint, requestedZoom: number): ViewportTransform {
    const worldPoint = this.viewportToWorld(viewportPoint);
    const zoom = clampCanvasZoom(requestedZoom);
    return new ViewportTransform({
      zoom,
      pan: {
        x: viewportPoint.x - worldPoint.x * zoom,
        y: viewportPoint.y - worldPoint.y * zoom,
      },
    });
  }

  toCssTransform(): string {
    return `translate3d(${this.pan.x}px, ${this.pan.y}px, 0) scale(${this.zoom})`;
  }
}

export function clientPointInViewport(
  clientPoint: CanvasPoint,
  viewportRect: Pick<DOMRect, "left" | "top">,
): CanvasPoint {
  return {
    x: clientPoint.x - viewportRect.left,
    y: clientPoint.y - viewportRect.top,
  };
}
